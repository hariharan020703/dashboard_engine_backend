const bcrypt = require('bcryptjs');
const { db, T } = require('../config/database');
const { UNIQUE_VIOLATION } = require('../config/pgPool');
const { BCRYPT_ROUNDS, MIN_PASSWORD_LENGTH } = require('../config/auth');
const { fail } = require('../api/response');
const { likePattern, orderBy, pagedRows } = require('../api/listQuery');
const {
  ROLE_SCOPES,
  PERMISSION_IDS,
  ROLE_SCOPE_BY_NAME,
  SUPER_ADMIN,
} = require('./permissionCatalogue');
const { companyScope, assertCompanyMatch } = require('./authorization');

/**
 * Reading and writing user records, and resolving a role to its permissions.
 *
 * Routes own HTTP shape; everything that touches the users, roles or
 * role_permissions tables lives here, so there is one place to look when asking
 * "what can this account do, and whose account is it".
 *
 * Every read that can return somebody else's row takes the acting user and
 * filters by company in SQL. Fetching first and checking afterwards works too,
 * but it makes the safe version and the unsafe version look almost identical at
 * the call site, and only one of them is reviewed carefully.
 */

/** Usernames become audit-log keys and sign-in identifiers. Keep them tame. */
const USERNAME_RE = /^[a-zA-Z0-9._-]{2,50}$/;
// Deliberately permissive: the authority on whether an address exists is the
// activation mail arriving, not a regular expression.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/*
 * The account columns every read uses. The bcrypt hash is deliberately not
 * among them: only the two paths that verify a password select it
 * (findUserByIdentifier for sign-in, findCredentialsById for a change), so a
 * user list or a per-request actor read never carries a hash out of the
 * database. `has_password` answers "is this account activated" for the one
 * caller that needs to know, without the hash itself.
 */
const USER_COLUMNS = `u.id, u.company_id, u.username, u.email, u.display_name,
                      (u.password_hash IS NOT NULL) AS has_password,
                      u.role, u.status, u.must_change_password,
                      u.last_login_at, u.created_at`;

/** Shape safe to hand to a browser: no hash, no token state. */
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id ?? null,
    companyName: row.companyName ?? null,
    username: row.username,
    email: row.email,
    displayName: row.display_name || null,
    role: row.role,
    status: row.status,
    mustChangePassword: Boolean(row.must_change_password),
    lastLoginAt: row.last_login_at || null,
    createdAt: row.created_at || null,
  };
}

/* ------------------------------------------------------------------ reads --- */

/**
 * The account behind a sign-in identifier - username or email, either works.
 *
 * Returns the full row including the hash, so it is only ever called from the
 * login path and from middleware.
 */
async function findUserByIdentifier(identifier) {
  const value = String(identifier || '').trim();
  if (!value) return null;
  const { rows } = await db.query(
    `SELECT ${USER_COLUMNS}, u.password_hash,
            c.active AS "companyActive", c.name AS "companyName"
       FROM ${T.users} u
       LEFT JOIN ${T.companies} c ON c.id = u.company_id
      WHERE u.username = ? OR u.email = ?`,
    [value, value.toLowerCase()]
  );
  return rows[0] || null;
}

/** Just the stored hash, for verifying a password change. */
async function findCredentialsById(id) {
  const { rows } = await db.query(`SELECT password_hash FROM ${T.users} WHERE id = ?`, [id]);
  return rows[0] || null;
}

/**
 * Everything requireAuth needs about the caller, in ONE round trip: the account,
 * its company's status, its role's permissions and its data scopes.
 *
 * This runs on every authenticated request, so its cost is paid by every
 * screen. As three sequential queries it was three network round trips before
 * a handler could start - against a managed database ~260 ms away, most of a
 * second of every response. Subselects keep it one statement.
 *
 * `permissions` is the raw role_permissions list; SUPER_ADMIN and retired ids
 * are resolved by rolePermissionList() exactly as getRolePermissions does.
 */
async function findActorRow(id) {
  const { rows } = await db.query(
    `SELECT ${USER_COLUMNS}, c.active AS "companyActive", c.name AS "companyName",
            COALESCE((SELECT array_agg(rp.permission_id) FROM ${T.rolePermissions} rp
                       WHERE rp.role_name = u.role), '{}') AS permissions,
            COALESCE((SELECT json_agg(json_build_array(s.dimension, s.value)
                                      ORDER BY s.dimension, s.value)
                        FROM ${T.userDataScope} s WHERE s.user_id = u.id), '[]') AS scopes
       FROM ${T.users} u
       LEFT JOIN ${T.companies} c ON c.id = u.company_id
      WHERE u.id = ?`,
    [id]
  );
  const row = rows[0];
  if (!row) return null;
  const scopes = {};
  for (const [dimension, value] of row.scopes) (scopes[dimension] = scopes[dimension] || []).push(value);
  return { user: row, permissions: rolePermissionList(row.role, row.permissions), scopes };
}

/** The account with this id, ignoring the company boundary. Middleware only. */
async function findUserById(id, conn) {
  const client = conn || db;
  const { rows } = await client.query(
    `SELECT ${USER_COLUMNS}, c.active AS "companyActive", c.name AS "companyName"
       FROM ${T.users} u
       LEFT JOIN ${T.companies} c ON c.id = u.company_id
      WHERE u.id = ?`,
    [id]
  );
  return rows[0] || null;
}

/**
 * The account with this id as far as `actor` is concerned.
 *
 * A company-scoped caller asking about another company's user gets the same
 * answer as one asking about an id that does not exist. That is deliberate:
 * distinguishing them turns /api/users/:id into a way to count a competitor's
 * accounts.
 */
async function findUserInScope(actor, id) {
  const scope = companyScope(actor, 'u.company_id');
  const { rows } = await db.query(
    `SELECT ${USER_COLUMNS}, c.name AS "companyName"
       FROM ${T.users} u
       LEFT JOIN ${T.companies} c ON c.id = u.company_id
      WHERE u.id = ? AND ${scope.clause}`,
    [id, ...scope.params]
  );
  return rows[0] || null;
}

/** As findUserInScope, but a missing row is a 404 rather than null. */
async function requireUserInScope(actor, id) {
  const user = await findUserInScope(actor, id);
  if (!user) throw fail('RESOURCE_NOT_FOUND', 'User not found');
  return user;
}

/*
 * Sort keys the people table offers, mapped to the SQL that orders by them.
 * `name` is what the Name column shows: the display name, else the username.
 */
const USER_SORTS = {
  name: 'lower(COALESCE(u.display_name, u.username))',
  company: 'lower(c.name)',
  role: 'u.role',
  status: 'u.status',
  lastLogin: 'u.last_login_at',
};

const USER_STATUSES = ['active', 'pending', 'disabled'];

/**
 * One row of the people table - the columns it renders and nothing else.
 *
 * Optional fields are omitted when empty rather than sent as null: no display
 * name, never signed in, or (platform view) no company because it is a
 * platform account. `companyName` is only ever sent to a platform caller; a
 * company caller's list is one company by definition.
 */
function userListItem(row, withCompany) {
  const item = { id: row.id, username: row.username, email: row.email, role: row.role, status: row.status };
  if (row.display_name) item.displayName = row.display_name;
  if (row.last_login_at) item.lastLoginAt = row.last_login_at;
  if (withCompany && row.companyName) item.companyName = row.companyName;
  return item;
}

/**
 * One page of the user directory the caller may see, searched, filtered and
 * sorted in SQL.
 *
 * A platform caller sees everyone and may narrow with `companyId`; a company
 * caller sees their own company and cannot widen, because the filter is applied
 * to their own id rather than to anything from the request.
 *
 * @param list     parseListQuery() output
 * @param filters  { companyId, role, status }
 */
async function listUsers(actor, list, { companyId, role, status } = {}) {
  const where = [];
  const params = [];

  if (actor.isPlatform) {
    if (companyId !== undefined && companyId !== null && companyId !== '') {
      const id = Number(companyId);
      if (!Number.isInteger(id) || id < 1) throw fail('VALIDATION_ERROR', 'companyId must be a positive integer.');
      where.push('u.company_id = ?');
      params.push(id);
    }
  } else {
    where.push('u.company_id = ?');
    params.push(actor.companyId);
  }
  if (role) {
    if (!ROLE_SCOPE_BY_NAME.has(String(role))) throw fail('VALIDATION_ERROR', `Unknown role: "${role}"`);
    where.push('u.role = ?');
    params.push(String(role));
  }
  if (status) {
    if (!USER_STATUSES.includes(String(status))) {
      throw fail('VALIDATION_ERROR', `status must be one of: ${USER_STATUSES.join(', ')}.`);
    }
    where.push('u.status = ?');
    params.push(String(status));
  }
  if (list.search) {
    where.push(`(u.username ILIKE ? OR u.email ILIKE ? OR u.display_name ILIKE ?)`);
    const pattern = likePattern(list.search);
    params.push(pattern, pattern, pattern);
  }

  const from = `FROM ${T.users} u
       LEFT JOIN ${T.companies} c ON c.id = u.company_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;

  return pagedRows(
    db,
    `SELECT u.id, u.username, u.email, u.display_name, u.role, u.status, u.last_login_at,
            c.name AS "companyName", COUNT(*) OVER () AS "__total"
       ${from}
      ${orderBy(list, USER_SORTS, 'u.id')}
      LIMIT ? OFFSET ?`,
    [...params, list.pageSize, list.offset],
    `SELECT COUNT(*) AS n ${from}`,
    params,
    (row) => userListItem(row, actor.isPlatform)
  );
}

/** id, username and email for the pickers, never crossing the company line. */
async function listUserOptions(actor) {
  const scope = companyScope(actor, 'u.company_id');
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.email
       FROM ${T.users} u
      WHERE u.status = 'active' AND ${scope.clause}
      ORDER BY u.username`,
    scope.params
  );
  return rows;
}

/* ------------------------------------------------------------------ roles --- */

/**
 * The permissions a role holds.
 *
 * SUPER_ADMIN is answered from the catalogue rather than the table: the
 * platform must stay recoverable after a bad permission edit, so the owner can
 * always reach the screen that would undo it.
 */
async function getRolePermissions(roleName) {
  if (!roleName) return [];
  if (roleName === SUPER_ADMIN) return [...PERMISSION_IDS];
  const { rows } = await db.query(
    `SELECT permission_id FROM ${T.rolePermissions} WHERE role_name = ?`,
    [roleName]
  );
  return rolePermissionList(roleName, rows.map((r) => r.permission_id));
}

/**
 * The effective list for a role, from its stored ids. SUPER_ADMIN is answered
 * from the catalogue; a permission since retired from the catalogue is dropped
 * here rather than handed to `can`, which would throw on it.
 */
function rolePermissionList(roleName, storedIds) {
  if (roleName === SUPER_ADMIN) return [...PERMISSION_IDS];
  return (storedIds || []).filter((id) => PERMISSION_IDS.includes(id));
}

/** The role row for a name, or null. Role names are case-sensitive constants. */
async function findRole(name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  const { rows } = await db.query(
    `SELECT id, name, scope, description FROM ${T.roles} WHERE name = ?`,
    [name.trim()]
  );
  return rows[0] || null;
}

/**
 * Checks that a role and a company id are a legal pair before either is
 * written.
 *
 * The invariant is "company_id is null exactly when the role is platform-
 * scoped", and it cannot be expressed as a column constraint, so it is asserted
 * on every path that sets either half.
 */
function assertRoleCompanyPairing(roleName, companyId) {
  const scope = ROLE_SCOPE_BY_NAME.get(roleName);
  if (!scope) throw fail('VALIDATION_ERROR', `Unknown role: "${roleName}"`);

  if (scope === ROLE_SCOPES.platform && companyId) {
    throw fail('VALIDATION_ERROR', `${roleName} is a platform role and cannot belong to a company.`);
  }
  if (scope === ROLE_SCOPES.company && !companyId) {
    throw fail('VALIDATION_ERROR', `${roleName} must belong to a company.`);
  }
  return scope;
}

/* ------------------------------------------------------------- validation --- */

/** Validates a password against the configured policy. Returns a message or null. */
function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > 200) return 'Password must be 200 characters or fewer';
  // Length alone is weak guidance; requiring a second character class catches
  // the "aaaaaaaa" case without imposing a composition rule nobody can satisfy.
  if (!/[^a-zA-Z]/.test(password)) {
    return 'Password must contain at least one digit or symbol';
  }
  return null;
}

function usernameProblem(username) {
  const clean = String(username || '').trim();
  if (!USERNAME_RE.test(clean)) {
    return 'Username must be 2-50 characters: letters, digits, dot, underscore or hyphen';
  }
  if (/^\d+$/.test(clean)) return 'Username cannot be entirely numeric';
  return null;
}

function emailProblem(email) {
  const clean = String(email || '').trim();
  if (!clean) return 'Email is required';
  if (clean.length > 190) return 'Email must be 190 characters or fewer';
  if (!EMAIL_RE.test(clean)) return 'That does not look like an email address';
  return null;
}

const hashPassword = (password) => bcrypt.hashSync(String(password), BCRYPT_ROUNDS);

/**
 * Constant-time-ish password check that also answers false for an account with
 * no password set.
 *
 * A pending account has `password_hash = NULL`. bcrypt.compareSync against null
 * returns false quickly, which would make "not activated yet" measurably faster
 * than "wrong password"; comparing against a fixed dummy hash instead keeps the
 * two paths doing the same work.
 */
const DUMMY_HASH = bcrypt.hashSync('password-that-is-never-valid', BCRYPT_ROUNDS);

function verifyPassword(password, hash) {
  return bcrypt.compareSync(String(password || ''), String(hash || DUMMY_HASH));
}

/* ----------------------------------------------------------------- writes --- */

/**
 * Creates an account in `companyId` with no usable password.
 *
 * The account is `pending` until its activation link is used, so there is never
 * a window in which it holds a credential somebody other than its owner has
 * seen. The caller is responsible for issuing the link and sending it.
 *
 * `conn` joins an open transaction - the path that creates a company and its
 * first administrator writes both, and neither is any use without the other.
 */
async function createUser({ companyId, username, email, displayName, role, createdBy }, conn) {
  assertRoleCompanyPairing(role, companyId);

  const nameProblem = usernameProblem(username);
  if (nameProblem) throw fail('VALIDATION_ERROR', nameProblem);
  const mailProblem = emailProblem(email);
  if (mailProblem) throw fail('VALIDATION_ERROR', mailProblem);

  const client = conn || db;
  try {
    const { rows } = await client.query(
      `INSERT INTO ${T.users}
         (company_id, username, email, display_name, password_hash, role, status, must_change_password)
       VALUES (?, ?, ?, ?, NULL, ?, 'pending', FALSE)
       RETURNING id`,
      [
        companyId ?? null,
        String(username).trim(),
        String(email).trim().toLowerCase(),
        displayName ? String(displayName).trim().slice(0, 120) : null,
        role,
      ]
    );
    return await findUserById(rows[0].id, conn);
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      throw fail('CONFLICT', 'An account with that username or email already exists.');
    }
    throw err;
  }
  // `createdBy` is recorded in the audit trail by the route, not in the row:
  // one immutable record beats a column that a later update could rewrite.
}

/** Applies a validated set of column updates to one account. */
async function updateUserColumns(id, updates) {
  const entries = Object.entries(updates);
  if (!entries.length) throw fail('VALIDATION_ERROR', 'Nothing to update');
  const sql = entries.map(([column]) => `${column} = ?`).join(', ');
  await db.query(
    `UPDATE ${T.users} SET ${sql} WHERE id = ?`,
    [...entries.map(([, value]) => value), id]
  );
}

/** Sets a password, marks the account active, and clears the change-required flag. */
async function setPassword(userId, password, { mustChange = false } = {}) {
  await db.query(
    `UPDATE ${T.users}
        SET password_hash = ?, status = 'active', must_change_password = ?
      WHERE id = ?`,
    [hashPassword(password), Boolean(mustChange), userId]
  );
}

async function recordLogin(userId) {
  await db.query(`UPDATE ${T.users} SET last_login_at = now() WHERE id = ?`, [userId]);
}

async function deleteUser(id) {
  const result = await db.query(`DELETE FROM ${T.users} WHERE id = ?`, [id]);
  return result.rowCount > 0;
}

module.exports = {
  USERNAME_RE,
  publicUser,
  findUserByIdentifier,
  findUserById,
  findActorRow,
  findCredentialsById,
  findUserInScope,
  requireUserInScope,
  listUsers,
  USER_SORTS,
  listUserOptions,
  getRolePermissions,
  findRole,
  assertRoleCompanyPairing,
  assertCompanyMatch,
  passwordProblem,
  usernameProblem,
  emailProblem,
  hashPassword,
  verifyPassword,
  createUser,
  updateUserColumns,
  setPassword,
  recordLogin,
  deleteUser,
};
