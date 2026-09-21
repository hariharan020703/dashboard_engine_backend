const { db, T } = require('../config/database');
const { fail } = require('../api/response');
const { companyScope } = require('./authorization');

/**
 * Groups and their membership.
 *
 * Lives here rather than in the router because two routers need the same
 * company-scoped lookup: groupRoutes manages the group, accessRoutes grants
 * dashboards to it, and both have to answer "is this group mine" the same way.
 * One of them importing the other's internals is how those two answers drift.
 */

const LIST_SQL = `
  SELECT g.id, g.company_id AS "companyId", c.name AS "companyName", g.name, g.active,
         g.created_at AS "createdAt", COUNT(gu.user_id) AS "memberCount"
    FROM ${T.groups} g
    JOIN ${T.companies} c ON c.id = g.company_id
    LEFT JOIN ${T.groupUsers} gu ON gu.group_id = g.id`;

function shapeGroup(row) {
  if (!row) return null;
  return { ...row, active: Boolean(row.active), memberCount: Number(row.memberCount) };
}

/** Every group the caller may see. */
async function listGroups(actor) {
  const scope = companyScope(actor, 'g.company_id');
  const { rows } = await db.query(
    `${LIST_SQL} WHERE ${scope.clause} GROUP BY g.id, c.name ORDER BY c.name, g.name`,
    scope.params
  );
  return rows.map(shapeGroup);
}

/**
 * The group with this id as far as the caller is concerned, or a 404.
 *
 * A company-scoped caller asking about another company's group gets the same
 * answer as one asking about an id that does not exist.
 */
async function requireGroupInScope(actor, id) {
  const scope = companyScope(actor, 'g.company_id');
  const { rows } = await db.query(
    `${LIST_SQL} WHERE g.id = ? AND ${scope.clause} GROUP BY g.id, c.name`,
    [id, ...scope.params]
  );
  if (!rows[0]) throw fail('RESOURCE_NOT_FOUND', 'Group not found');
  return shapeGroup(rows[0]);
}

async function memberIds(groupId) {
  const { rows } = await db.query(
    `SELECT user_id FROM ${T.groupUsers} WHERE group_id = ?`,
    [groupId]
  );
  return rows.map((r) => r.user_id);
}

async function listMembers(groupId) {
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.email, u.role, u.status
       FROM ${T.groupUsers} gu
       JOIN ${T.users} u ON u.id = gu.user_id
      WHERE gu.group_id = ? ORDER BY u.username`,
    [groupId]
  );
  return rows;
}

/**
 * Replaces a group's membership, inside a caller-supplied transaction.
 *
 * Every id is checked to exist AND to belong to the group's own company before
 * anything is written. Without the second half, a company administrator could
 * quietly pull another company's user into a group and hand them this company's
 * dashboards - the one way group membership could breach the tenant boundary.
 */
async function writeMembers(conn, group, userIds) {
  const unique = [...new Set(userIds.map(Number))];
  if (unique.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw fail('VALIDATION_ERROR', 'userIds must be positive integers');
  }

  await conn.query(`DELETE FROM ${T.groupUsers} WHERE group_id = ?`, [group.id]);
  if (!unique.length) return;

  const { rows: found } = await conn.query(
    `SELECT id FROM ${T.users}
      WHERE id IN (${unique.map(() => '?').join(', ')}) AND company_id = ?`,
    [...unique, group.companyId]
  );
  if (found.length !== unique.length) {
    const known = new Set(found.map((r) => r.id));
    const rejected = unique.filter((id) => !known.has(id));
    throw fail(
      'VALIDATION_ERROR',
      `These accounts are not in this company: ${rejected.join(', ')}`,
      { userIds: rejected }
    );
  }

  const placeholders = unique.map(() => '(?, ?)').join(', ');
  await conn.query(
    `INSERT INTO ${T.groupUsers} (group_id, user_id) VALUES ${placeholders}`,
    unique.flatMap((id) => [group.id, id])
  );
}

module.exports = { listGroups, requireGroupInScope, memberIds, listMembers, writeMembers, shapeGroup };
