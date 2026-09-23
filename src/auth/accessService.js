const { db, T, withTransaction } = require('../config/database');
const registry = require('../dashboard/dashboardRegistry');
const { fail } = require('../api/response');
const { ACCESS_LEVELS, strongestLevel, levelAtLeast } = require('./permissionCatalogue');
const { can, assertCompanyMatch } = require('./authorization');

/**
 * Who may reach which dashboard.
 *
 * Two gates, and a dashboard is only reachable through both:
 *
 *   1. the dashboard is ASSIGNED to the user's company (company_dashboards),
 *      which only the platform owner writes;
 *   2. the user holds a GRANT on it, directly or through an active group of
 *      their own company.
 *
 * Gate 1 is what makes changing a dashboardId in a URL pointless: a company
 * administrator cannot grant, and a user cannot hold, a dashboard their company
 * was never assigned. Gate 2 is the ordinary per-person sharing inside it.
 *
 * Dashboards themselves are not rows: dashboard/dashboardRegistry.js resolves an
 * id to a JSON file under config/dashboards, and that registry stays the only
 * source of truth for which dashboards exist. So an id is validated against the
 * registry on write and joined against it on read - which also means an
 * assignment left behind by a deleted dashboard file is inert rather than an
 * error.
 */

function isValidLevel(level) {
  return ACCESS_LEVELS.includes(level);
}

function requireLevel(level) {
  if (!isValidLevel(level)) {
    throw fail('VALIDATION_ERROR', `Access level must be one of: ${ACCESS_LEVELS.join(', ')}`);
  }
  return level;
}

/** A dashboard id the registry can resolve, or a 404. */
async function requireDashboardId(dashboardId) {
  const id = String(dashboardId || '');
  const all = await registry.listDashboards();
  if (!all.some((d) => d.id === id)) {
    throw fail('DASHBOARD_NOT_FOUND', 'Dashboard not found');
  }
  return id;
}

/* ------------------------------------------------------------ assignments --- */

/** Dashboard ids assigned to or owned by a company. */
async function companyDashboardIds(companyId) {
  const { rows: assigned } = await db.query(
    `SELECT dashboard_id FROM ${T.companyDashboards} WHERE company_id = ?`,
    [companyId]
  );
  let owned = [];
  try {
    const res = await db.query(
      `SELECT id AS dashboard_id FROM ${T.dashboards} WHERE company_id = ?`,
      [companyId]
    );
    owned = res.rows;
  } catch (_) {}
  return new Set([...assigned.map((r) => r.dashboard_id), ...owned.map((r) => r.dashboard_id)]);
}

/** The dashboards a company may use, joined against the registry for titles. */
async function listCompanyDashboards(companyId) {
  const assigned = await companyDashboardIds(companyId);
  const all = await registry.listDashboards(companyId);
  return all
    .filter((d) => assigned.has(d.id))
    .map((d) => ({ ...d, assigned: true }));
}

/** Every dashboard in the registry, flagged with whether this company has it. */
async function listAssignableDashboards(companyId) {
  const assigned = await companyDashboardIds(companyId);
  const all = await registry.listDashboards();
  return all.map((d) => ({ ...d, assigned: assigned.has(d.id) }));
}

async function assignDashboard(companyId, dashboardId, assignedBy) {
  await db.query(
    `INSERT INTO ${T.companyDashboards} (company_id, dashboard_id, assigned_by)
     VALUES (?, ?, ?)
     ON CONFLICT (company_id, dashboard_id)
       DO UPDATE SET assigned_by = EXCLUDED.assigned_by, assigned_at = now()`,
    [companyId, dashboardId, assignedBy]
  );
}

/**
 * Removes a company's assignment, and with it every grant inside that company
 * that depended on it.
 *
 * Leaving the grants behind would mean re-assigning the dashboard later
 * silently restores access somebody revoked in between, which is exactly the
 * kind of surprise an access model should not contain.
 */
async function unassignDashboard(companyId, dashboardId) {
  return withTransaction(async (conn) => {
    // PostgreSQL has no multi-table DELETE, so the rows to remove are selected
    // with a correlated subquery rather than a join in the DELETE itself.
    await conn.query(
      `DELETE FROM ${T.dashboardAccess}
        WHERE dashboard_id = ?
          AND user_id IN (SELECT id FROM ${T.users} WHERE company_id = ?)`,
      [dashboardId, companyId]
    );
    await conn.query(
      `DELETE FROM ${T.groupDashboardAccess}
        WHERE dashboard_id = ?
          AND group_id IN (SELECT id FROM ${T.groups} WHERE company_id = ?)`,
      [dashboardId, companyId]
    );
    const result = await conn.query(
      `DELETE FROM ${T.companyDashboards} WHERE company_id = ? AND dashboard_id = ?`,
      [companyId, dashboardId]
    );
    return result.rowCount > 0;
  });
}

/**
 * Refuses a dashboard the company has not been assigned.
 *
 * Called before every grant and before every read of dashboard data. The
 * platform role is exempt because it has no company to be outside of.
 */
async function assertDashboardAssigned(actor, companyId, dashboardId) {
  if (actor.isPlatform && companyId === null) return;
  const assigned = await companyDashboardIds(companyId);
  if (!assigned.has(dashboardId)) {
    throw fail('TENANT_ACCESS_DENIED', 'That dashboard is not available to this company.');
  }
}

/* ----------------------------------------------------------------- grants --- */

/**
 * The actor's level on one dashboard, or null.
 *
 * The two role-derived shortcuts here are stated in terms of permissions rather
 * than role names, so they stay true if the permission sets are edited:
 *
 *   - a platform account holding dashboard.assign administers every dashboard;
 *   - a company account holding access.grant administers every dashboard their
 *     company has been assigned, because granting a dashboard you cannot open
 *     is not a coherent capability.
 *
 * Everyone else needs an actual grant.
 */
async function getAccessLevel(actor, dashboardId) {
  if (!actor || !dashboardId) return null;

  if (actor.isPlatform) {
    return 'admin';
  }

  const assigned = await companyDashboardIds(actor.companyId);
  if (!assigned.has(dashboardId)) return null;

  if (can(actor, 'access.grant')) return 'admin';

  const { rows } = await db.query(
    `SELECT access_level FROM ${T.dashboardAccess}
      WHERE user_id = ? AND dashboard_id = ?
     UNION ALL
     SELECT gda.access_level
       FROM ${T.groupDashboardAccess} gda
       JOIN ${T.groupUsers} gu ON gu.group_id = gda.group_id
       JOIN ${T.groups} g ON g.id = gda.group_id
      WHERE gu.user_id = ? AND gda.dashboard_id = ? AND g.active AND g.company_id = ?`,
    [actor.id, dashboardId, actor.id, dashboardId, actor.companyId]
  );

  const levels = rows.map((r) => r.access_level);
  if (can(actor, 'dashboard.update')) levels.push('developer');
  return strongestLevel(levels) || (can(actor, 'dashboard.update') ? 'developer' : null);
}

/** Asserts the actor holds at least `required` on a dashboard. */
async function assertDashboardLevel(actor, dashboardId, required) {
  const level = await getAccessLevel(actor, dashboardId);
  if (!level) {
    // Same answer as a dashboard that does not exist. A user probing ids should
    // not be able to map which dashboards other companies have.
    throw fail('DASHBOARD_NOT_FOUND', 'Dashboard not found');
  }
  if (!levelAtLeast(level, required)) {
    throw fail('INSUFFICIENT_PERMISSION', `This action needs "${required}" access to the dashboard.`);
  }
  return level;
}

/** The dashboards the actor may open, each carrying the level they hold. */
async function listAccessibleDashboards(actor) {
  if (actor.isPlatform) {
    const all = await registry.listDashboards();
    return all.map((d) => ({ ...d, accessLevel: 'admin' }));
  }

  const assigned = await companyDashboardIds(actor.companyId);
  const all = await registry.listDashboards(actor.companyId);
  const visible = all.filter((d) => assigned.has(d.id));

  if (can(actor, 'access.grant')) {
    return visible.map((d) => ({ ...d, accessLevel: 'admin' }));
  }

  const { rows } = await db.query(
    `SELECT dashboard_id, access_level FROM ${T.dashboardAccess} WHERE user_id = ?
     UNION ALL
     SELECT gda.dashboard_id, gda.access_level
       FROM ${T.groupDashboardAccess} gda
       JOIN ${T.groupUsers} gu ON gu.group_id = gda.group_id
       JOIN ${T.groups} g ON g.id = gda.group_id
      WHERE gu.user_id = ? AND g.active AND g.company_id = ?`,
    [actor.id, actor.id, actor.companyId]
  );

  const byDashboard = new Map();
  for (const row of rows) {
    byDashboard.set(
      row.dashboard_id,
      strongestLevel([byDashboard.get(row.dashboard_id), row.access_level].filter(Boolean))
    );
  }

  const canUpdate = can(actor, 'dashboard.update');

  return visible
    .filter((d) => byDashboard.has(d.id) || canUpdate)
    .map((d) => {
      const explicitLevel = byDashboard.get(d.id);
      const effectiveLevel = canUpdate
        ? strongestLevel([explicitLevel, 'developer'].filter(Boolean))
        : explicitLevel;
      return { ...d, accessLevel: effectiveLevel || 'view' };
    });
}

/** Every grant reaching one user, direct and inherited, labelled by origin. */
async function listUserGrants(userId) {
  const { rows: direct } = await db.query(
    `SELECT dashboard_id AS "dashboardId", access_level AS level, 'direct' AS origin,
            NULL::int AS "groupId", NULL::text AS "groupName"
       FROM ${T.dashboardAccess} WHERE user_id = ?`,
    [userId]
  );
  const { rows: inherited } = await db.query(
    `SELECT gda.dashboard_id AS "dashboardId", gda.access_level AS level, 'group' AS origin,
            g.id AS "groupId", g.name AS "groupName"
       FROM ${T.groupDashboardAccess} gda
       JOIN ${T.groups} g ON g.id = gda.group_id
       JOIN ${T.groupUsers} gu ON gu.group_id = gda.group_id
       WHERE gu.user_id = ? AND g.active`,
    [userId]
  );

  const all = await registry.listDashboards();
  const titles = new Map(all.map((d) => [d.id, d.title]));
  return [...direct, ...inherited]
    .map((row) => ({ ...row, dashboardTitle: titles.get(row.dashboardId) || null }))
    .sort((a, b) => a.dashboardId.localeCompare(b.dashboardId));
}

/** Everyone in `companyId` who holds a grant on a dashboard, users and groups. */
async function listDashboardGrants(companyId, dashboardId) {
  const { rows: users } = await db.query(
    `SELECT a.user_id AS "userId", u.username, u.email, a.access_level AS level,
            a.granted_at AS "grantedAt"
       FROM ${T.dashboardAccess} a
       JOIN ${T.users} u ON u.id = a.user_id
      WHERE a.dashboard_id = ? AND u.company_id = ?
      ORDER BY u.username`,
    [dashboardId, companyId]
  );
  const { rows: groups } = await db.query(
    `SELECT gda.group_id AS "groupId", g.name AS "groupName", gda.access_level AS level,
            gda.granted_at AS "grantedAt", g.active
       FROM ${T.groupDashboardAccess} gda
       JOIN ${T.groups} g ON g.id = gda.group_id
      WHERE gda.dashboard_id = ? AND g.company_id = ?
      ORDER BY g.name`,
    [dashboardId, companyId]
  );
  return {
    dashboardId,
    users,
    groups: groups.map((g) => ({ ...g, active: Boolean(g.active) })),
  };
}

/* ---------------------------------------------------------------- writing --- */

async function grantUserAccess(userId, dashboardId, level, grantedBy) {
  await db.query(
    `INSERT INTO ${T.dashboardAccess} (user_id, dashboard_id, access_level, granted_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, dashboard_id)
       DO UPDATE SET access_level = EXCLUDED.access_level, granted_by = EXCLUDED.granted_by`,
    [userId, dashboardId, level, grantedBy]
  );
}

async function revokeUserAccess(userId, dashboardId) {
  const result = await db.query(
    `DELETE FROM ${T.dashboardAccess} WHERE user_id = ? AND dashboard_id = ?`,
    [userId, dashboardId]
  );
  return result.rowCount > 0;
}

async function grantGroupAccess(groupId, dashboardId, level, grantedBy) {
  await db.query(
    `INSERT INTO ${T.groupDashboardAccess} (group_id, dashboard_id, access_level, granted_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (group_id, dashboard_id)
       DO UPDATE SET access_level = EXCLUDED.access_level, granted_by = EXCLUDED.granted_by`,
    [groupId, dashboardId, level, grantedBy]
  );
}

async function revokeGroupAccess(groupId, dashboardId) {
  const result = await db.query(
    `DELETE FROM ${T.groupDashboardAccess} WHERE group_id = ? AND dashboard_id = ?`,
    [groupId, dashboardId]
  );
  return result.rowCount > 0;
}

module.exports = {
  isValidLevel,
  requireLevel,
  requireDashboardId,
  companyDashboardIds,
  listCompanyDashboards,
  listAssignableDashboards,
  assignDashboard,
  unassignDashboard,
  assertDashboardAssigned,
  getAccessLevel,
  assertDashboardLevel,
  listAccessibleDashboards,
  listUserGrants,
  listDashboardGrants,
  grantUserAccess,
  revokeUserAccess,
  grantGroupAccess,
  revokeGroupAccess,
  assertCompanyMatch,
};
