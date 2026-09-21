const express = require('express');
const { db, T, withTransaction } = require('../config/database');
const { ok, fail } = require('../api/response');
const {
  ALL_PERMISSIONS,
  ALL_PERMISSION_IDS,
  PLATFORM_ONLY_PERMISSIONS,
  ACCESS_LEVELS,
  ACCESS_LEVEL_LABELS,
  ROLE_SCOPES,
  SUPER_ADMIN,
} = require('../auth/permissionCatalogue');
const { assertRolePermissionsAllowed } = require('../auth/authorization');
const { findRole } = require('../auth/userService');
const { audit, EVENTS } = require('../auth/auditService');
const {
  requireRbac,
  requireAuth,
  requirePasswordCurrent,
  requirePermission,
} = require('../middleware/auth');

/**
 * The three roles, and what each of them may do.
 *
 * There is no create, rename or delete here, deliberately. The business model
 * names exactly SUPER_ADMIN, COMPANY_ADMIN and USER, and a fourth role would
 * have no defined answer to the only question that matters - is it bounded by a
 * company or not. What remains editable is the permission set of the two
 * company roles, which is genuine configuration.
 */
const router = express.Router();

router.use(requireRbac, requireAuth, requirePasswordCurrent);

// Literal paths first: /permissions must not be read as a role name.

/*
 * GET /api/roles/permissions - the catalogue the role editor renders.
 *
 * Available to anyone who may read roles, including a company administrator:
 * it is the vocabulary, not a grant, and their screens label permissions with it.
 */
router.get('/permissions', requirePermission('role.read'), (req, res) => {
  ok(res, ALL_PERMISSIONS.map((p) => ({ ...p, platformOnly: PLATFORM_ONLY_PERMISSIONS.has(p.id) })));
});

// GET /api/roles/access-levels - the per-dashboard levels, ranked weakest first
router.get('/access-levels', requirePermission('role.read'), (req, res) => {
  ok(res, ACCESS_LEVELS.map((id) => ({ id, description: ACCESS_LEVEL_LABELS[id] })));
});

// GET /api/roles - the three roles, with how many accounts hold each
router.get('/', requirePermission('role.read'), async (req, res) => {
  const { rows } = await db.query(
    `SELECT r.name, r.scope, r.description,
            (SELECT COUNT(*) FROM ${T.users} u WHERE u.role = r.name) AS "userCount"
       FROM ${T.roles} r
      ORDER BY CASE r.scope WHEN 'platform' THEN 0 ELSE 1 END, r.name`
  );
  ok(res, rows.map((r) => ({ ...r, userCount: Number(r.userCount) })));
});

// GET /api/roles/:name/permissions - the permissions a role holds
router.get('/:name/permissions', requirePermission('role.read'), async (req, res) => {
  const role = await findRole(req.params.name);
  if (!role) throw fail('RESOURCE_NOT_FOUND', 'Role not found');

  if (role.name === SUPER_ADMIN) {
    // Answered from the catalogue, not the table - see getRolePermissions.
    ok(res, { role: role.name, scope: role.scope, editable: false, permissions: [...ALL_PERMISSION_IDS] });
    return;
  }

  const { rows } = await db.query(
    `SELECT permission_id FROM ${T.rolePermissions} WHERE role_name = ? ORDER BY permission_id`,
    [role.name]
  );
  ok(res, {
    role: role.name,
    scope: role.scope,
    editable: true,
    permissions: rows.map((r) => r.permission_id),
  });
});

/*
 * PUT /api/roles/:name/permissions - replace a role's permission set.
 *
 * Platform-only, because changing what COMPANY_ADMIN may do is a change to the
 * product's boundaries rather than to one customer's configuration.
 */
router.put('/:name/permissions', requirePermission('role.update'), async (req, res) => {
  const role = await findRole(req.params.name);
  if (!role) throw fail('RESOURCE_NOT_FOUND', 'Role not found');

  if (role.name === SUPER_ADMIN) {
    throw fail(
      'VALIDATION_ERROR',
      'SUPER_ADMIN always holds every permission and cannot be edited - that is what keeps the platform recoverable from a bad permission change.'
    );
  }

  const { permissions } = req.body || {};
  if (!Array.isArray(permissions)) {
    throw fail('VALIDATION_ERROR', 'permissions must be an array of permission ids');
  }

  const unique = [...new Set(permissions.map(String))];
  const unknown = unique.filter((id) => !ALL_PERMISSION_IDS.has(id));
  if (unknown.length) {
    throw fail('VALIDATION_ERROR', `Unknown permission id(s): ${unknown.join(', ')}`, { permissions: unknown });
  }

  // The check that stops a company role being handed a platform capability.
  assertRolePermissionsAllowed(role.scope, unique);

  await withTransaction(async (conn) => {
    await conn.query(`DELETE FROM ${T.rolePermissions} WHERE role_name = ?`, [role.name]);
    if (unique.length) {
      const placeholders = unique.map(() => '(?, ?)').join(', ');
      await conn.query(
        `INSERT INTO ${T.rolePermissions} (role_name, permission_id) VALUES ${placeholders}`,
        unique.flatMap((id) => [role.name, id])
      );
    }
  });

  audit(EVENTS.ROLE_PERMISSIONS_UPDATED, req.actor, { role: role.name, permissionCount: unique.length });
  ok(res, {
    role: role.name,
    scope: role.scope,
    editable: role.scope !== ROLE_SCOPES.platform || role.name !== SUPER_ADMIN,
    permissions: unique,
  });
});

module.exports = router;
