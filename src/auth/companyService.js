const { db, T } = require('../config/database');
const { UNIQUE_VIOLATION } = require('../config/pgPool');
const { fail, requireString } = require('../api/response');

/**
 * Companies: the tenant boundary every other table hangs off.
 *
 * A company owns its users, its groups, the dashboards assigned to it and every
 * grant inside it. Nothing here is company-scoped itself - managing companies
 * is a platform capability - but this is where the identifiers the rest of the
 * system filters on are created and validated.
 */

// Slugs appear in URLs and audit records, so they stay to a plain alphabet.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** Derives a slug from a name, for when the caller does not supply one. */
function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

function shapeCompany(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    active: Boolean(row.active),
    createdAt: row.created_at || null,
    userCount: row.userCount === undefined ? undefined : Number(row.userCount),
    dashboardCount: row.dashboardCount === undefined ? undefined : Number(row.dashboardCount),
  };
}

const LIST_SQL = `
  SELECT c.id, c.name, c.slug, c.active, c.created_at,
         (SELECT COUNT(*) FROM ${T.users} u WHERE u.company_id = c.id) AS "userCount",
         (SELECT COUNT(*) FROM ${T.companyDashboards} cd WHERE cd.company_id = c.id) AS "dashboardCount"
    FROM ${T.companies} c`;

/**
 * Every company, or just the one the caller belongs to.
 *
 * A company-scoped administrator legitimately needs to read their own company -
 * its name and status appear all over their screens - so this takes the actor
 * rather than being platform-only, and narrows the query instead of refusing.
 */
async function listCompanies(actor) {
  if (actor.isPlatform) {
    const { rows } = await db.query(`${LIST_SQL} ORDER BY c.name`);
    return rows.map(shapeCompany);
  }
  const { rows } = await db.query(`${LIST_SQL} WHERE c.id = ?`, [actor.companyId]);
  return rows.map(shapeCompany);
}

async function findCompanyById(id) {
  const { rows } = await db.query(`${LIST_SQL} WHERE c.id = ?`, [id]);
  return shapeCompany(rows[0]);
}

/** The company, or a 404. Company-scoped callers may only ask about their own. */
async function requireCompany(actor, id) {
  if (!actor.isPlatform && id !== actor.companyId) {
    throw fail('TENANT_ACCESS_DENIED', 'That company is not yours to view.');
  }
  const company = await findCompanyById(id);
  if (!company) throw fail('RESOURCE_NOT_FOUND', 'Company not found');
  return company;
}

/**
 * Inserts the company row and returns it as written.
 *
 * Takes an optional connection because onboarding a customer creates the
 * company and its first administrator together, and half of that is worse than
 * neither: a company nobody can administer, holding the name and the slug that
 * the retry needs. The raw row is returned rather than the shaped one, because
 * inside a transaction the counts in `findCompanyById` would be read on a
 * different connection and could not see this row yet.
 */
async function insertCompany(actor, { name, slug }, conn) {
  const cleanName = requireString(name, 'Company name', { max: 150, min: 2 });
  const cleanSlug = slug ? String(slug).trim().toLowerCase() : slugify(cleanName);

  if (!SLUG_RE.test(cleanSlug)) {
    throw fail(
      'VALIDATION_ERROR',
      'Company slug must be 3-64 characters of lowercase letters, digits and hyphens, and cannot start or end with a hyphen.'
    );
  }

  const client = conn || db;
  try {
    const { rows } = await client.query(
      `INSERT INTO ${T.companies} (name, slug, active, created_by) VALUES (?, ?, TRUE, ?)
       RETURNING id, name, slug, active, created_at`,
      [cleanName, cleanSlug, actor.id]
    );
    return rows[0];
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      throw fail('CONFLICT', 'A company with that name or slug already exists.');
    }
    throw err;
  }
}

/**
 * Renames a company or switches it on and off.
 *
 * Deactivating is the lever that stops a whole customer signing in: login
 * checks the company's status, and refresh does too, so existing sessions stop
 * at their next token rotation rather than running to the end of the day.
 */
async function updateCompany(id, { name, active }) {
  const updates = [];
  const params = [];

  if (name !== undefined) {
    updates.push('name = ?');
    params.push(requireString(name, 'Company name', { max: 150, min: 2 }));
  }
  if (typeof active === 'boolean') {
    updates.push('active = ?');
    params.push(active);
  }
  if (!updates.length) throw fail('VALIDATION_ERROR', 'Nothing to update');

  params.push(id);
  try {
    await db.query(`UPDATE ${T.companies} SET ${updates.join(', ')} WHERE id = ?`, params);
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw fail('CONFLICT', 'A company with that name already exists.');
    throw err;
  }
  return findCompanyById(id);
}

/**
 * Deletes a company and, by cascade, its users, groups, grants and dashboard
 * assignments.
 *
 * Refused while the company still has accounts. The cascade would work, but
 * "delete this company" and "delete these fourteen people's accounts" should
 * not be the same click without the caller having seen the second number.
 */
async function deleteCompany(id) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM ${T.users} WHERE company_id = ?`,
    [id]
  );
  const n = rows[0].n;
  if (n > 0) {
    throw fail(
      'CONFLICT',
      `This company still has ${n} account${n === 1 ? '' : 's'}. Delete them first.`
    );
  }
  const result = await db.query(`DELETE FROM ${T.companies} WHERE id = ?`, [id]);
  if (!result.rowCount) throw fail('RESOURCE_NOT_FOUND', 'Company not found');
}

/**
 * Deletes a company and everything under it, without the "no accounts left"
 * guard.
 *
 * Only for undoing a company creation whose invitation could not be delivered.
 * That company is seconds old, has exactly one account - the one just written -
 * and nobody has ever signed into it, so the guard `deleteCompany` applies is
 * protecting nothing here while making the undo impossible.
 */
async function deleteCompanyCascade(id) {
  await db.query(`DELETE FROM ${T.companies} WHERE id = ?`, [id]);
}

module.exports = {
  slugify,
  shapeCompany,
  listCompanies,
  findCompanyById,
  requireCompany,
  insertCompany,
  deleteCompanyCascade,
  updateCompany,
  deleteCompany,
};
