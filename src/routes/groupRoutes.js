const express = require('express');
const { db, T, withTransaction } = require('../config/database');
const { ok, fail, requireId, requireString } = require('../api/response');
const { UNIQUE_VIOLATION } = require('../config/pgPool');
const { resolveTargetCompany } = require('../auth/authorization');
const groups = require('../auth/groupService');
const companies = require('../auth/companyService');
const { audit, EVENTS } = require('../auth/auditService');
const {
  requireRbac,
  requireAuth,
  requirePasswordCurrent,
  requirePermission,
} = require('../middleware/auth');

/**
 * Groups: a named set of users inside one company that dashboard access can be
 * attached to, so it is managed per team rather than per person.
 *
 * A user's effective level on a dashboard is the strongest of their direct
 * grant and the grants of every active group they belong to - see
 * auth/accessService.js. Grants themselves are managed in accessRoutes.js; this
 * router owns the group and its membership, and auth/groupService.js owns the
 * company-scoped lookups both of them share.
 */
const router = express.Router();

router.use(requireRbac, requireAuth, requirePasswordCurrent);

// GET /api/groups - the groups the caller may see, with their member counts
router.get('/', requirePermission('group.read'), async (req, res) => {
  ok(res, await groups.listGroups(req.actor));
});

// POST /api/groups - create a group, optionally with its members
router.post('/', requirePermission('group.create'), async (req, res) => {
  const { name, active = true, userIds = [] } = req.body || {};
  const groupName = requireString(name, 'Group name', { max: 100 });
  if (!Array.isArray(userIds)) throw fail('VALIDATION_ERROR', 'userIds must be an array');

  const companyId = resolveTargetCompany(req.actor, (req.body || {}).companyId);
  await companies.requireCompany(req.actor, companyId);

  let id;
  try {
    id = await withTransaction(async (conn) => {
      const { rows } = await conn.query(
        `INSERT INTO ${T.groups} (company_id, name, active, creator_id) VALUES (?, ?, ?, ?)
         RETURNING id`,
        [companyId, groupName, Boolean(active), req.actor.id]
      );
      await groups.writeMembers(conn, { id: rows[0].id, companyId }, userIds);
      return rows[0].id;
    });
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      throw fail('CONFLICT', 'A group with that name already exists in this company.');
    }
    throw err;
  }

  audit(EVENTS.GROUP_CREATED, req.actor, {
    groupId: id,
    name: groupName,
    companyId,
    memberCount: userIds.length,
  });
  ok(res, await groups.requireGroupInScope(req.actor, id), 201);
});

// GET /api/groups/:id - one group, with its member ids
router.get('/:id', requirePermission('group.read'), async (req, res) => {
  const group = await groups.requireGroupInScope(req.actor, requireId(req.params.id, 'group id'));
  ok(res, { ...group, userIds: await groups.memberIds(group.id) });
});

// PUT /api/groups/:id - rename, activate/deactivate, or replace the membership
router.put('/:id', requirePermission('group.update'), async (req, res) => {
  const id = requireId(req.params.id, 'group id');
  const group = await groups.requireGroupInScope(req.actor, id);
  const { name, active, userIds } = req.body || {};

  if (userIds !== undefined && !Array.isArray(userIds)) {
    throw fail('VALIDATION_ERROR', 'userIds must be an array');
  }

  const updates = [];
  const params = [];
  if (name !== undefined) {
    updates.push('name = ?');
    params.push(requireString(name, 'Group name', { max: 100 }));
  }
  if (typeof active === 'boolean') {
    updates.push('active = ?');
    params.push(active);
  }
  if (!updates.length && userIds === undefined) throw fail('VALIDATION_ERROR', 'Nothing to update');

  try {
    await withTransaction(async (conn) => {
      if (updates.length) {
        await conn.query(`UPDATE ${T.groups} SET ${updates.join(', ')} WHERE id = ?`, [...params, id]);
      }
      if (Array.isArray(userIds)) await groups.writeMembers(conn, group, userIds);
    });
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      throw fail('CONFLICT', 'A group with that name already exists in this company.');
    }
    throw err;
  }

  audit(EVENTS.GROUP_UPDATED, req.actor, {
    groupId: id,
    name: group.name,
    companyId: group.companyId,
    membershipReplaced: Array.isArray(userIds),
  });
  ok(res, await groups.requireGroupInScope(req.actor, id));
});

// DELETE /api/groups/:id - delete a group; its membership and grants cascade
router.delete('/:id', requirePermission('group.delete'), async (req, res) => {
  const id = requireId(req.params.id, 'group id');
  const group = await groups.requireGroupInScope(req.actor, id);

  await db.query(`DELETE FROM ${T.groups} WHERE id = ?`, [id]);
  audit(EVENTS.GROUP_DELETED, req.actor, { groupId: id, name: group.name, companyId: group.companyId });
  ok(res, { deleted: true });
});

// GET /api/groups/:id/members - the group's members
router.get('/:id/members', requirePermission('group.read'), async (req, res) => {
  const group = await groups.requireGroupInScope(req.actor, requireId(req.params.id, 'group id'));
  ok(res, await groups.listMembers(group.id));
});

module.exports = router;
