const { fail } = require('../api/response');
const {
  ROLE_SCOPES,
  PERMISSION_IDS,
  PLATFORM_ONLY_PERMISSIONS,
  ROLE_SCOPE_BY_NAME,
  SUPER_ADMIN,
} = require('./permissionCatalogue');

/**
 * The one authorization layer. Every allow/deny decision in the application is
 * made by a function in this file.
 *
 * The chain it implements, in order, is always:
 *
 *   identity -> company context -> role -> permission -> resource ownership
 *
 * Controllers call these helpers; they never compare a role name. That is the
 * difference between adding a capability (one permission id, one guard) and
 * auditing thirty `if (role === 'admin')` branches to find the one that was
 * missed.
 *
 * An "actor" is the object middleware/auth.js builds from a verified access
 * token. Its shape is fixed here so nothing downstream has to wonder whether a
 * field might be absent:
 *
 *   { id, username, email, role, roleScope, isPlatform, companyId, permissions[], status }
 *
 * `companyId` is null if and only if `isPlatform` is true.
 */

/**
 * Builds the actor from a database row plus its resolved permissions.
 *
 * This is the only place an actor is constructed, so "what does the request
 * know about the caller" has exactly one answer. Anything missing here is a
 * programming error and throws rather than defaulting - an actor with an
 * accidentally empty permission list would fail open on any check written as a
 * negation.
 */
function buildActor(userRow, permissions) {
  if (!userRow || !userRow.id) {
    throw new Error('buildActor requires a user row');
  }
  const roleScope = ROLE_SCOPE_BY_NAME.get(userRow.role);
  if (!roleScope) {
    // A role the catalogue does not define cannot be reasoned about, and
    // guessing a scope for it would be guessing whether the company boundary
    // applies to this request.
    throw fail(
      'INTERNAL_ERROR',
      `Account "${userRow.username}" holds unknown role "${userRow.role}".`
    );
  }
  const isPlatform = roleScope === ROLE_SCOPES.platform;

  if (isPlatform && userRow.company_id !== null && userRow.company_id !== undefined) {
    throw fail('INTERNAL_ERROR', `Platform account "${userRow.username}" must not belong to a company.`);
  }
  if (!isPlatform && !userRow.company_id) {
    throw fail('INTERNAL_ERROR', `Account "${userRow.username}" has no company.`);
  }

  return {
    id: userRow.id,
    username: userRow.username,
    email: userRow.email,
    displayName: userRow.display_name || null,
    role: userRow.role,
    roleScope,
    isPlatform,
    companyId: isPlatform ? null : userRow.company_id,
    status: userRow.status,
    mustChangePassword: Boolean(userRow.must_change_password),
    permissions: Object.freeze([...permissions]),
  };
}

/**
 * Whether the actor holds a permission.
 *
 * The platform role short-circuits, for the same reason its permissions are
 * answered from the catalogue rather than the table: the screen that fixes a
 * bad permission edit must never be the screen the edit locked away.
 */
function can(actor, permission) {
  if (!actor) return false;
  if (!PERMISSION_IDS.includes(permission)) {
    throw new Error(`Unknown permission "${permission}". Add it to auth/permissionCatalogue.js.`);
  }
  if (actor.role === SUPER_ADMIN) return true;
  return actor.permissions.includes(permission);
}

/** `can`, as an assertion. Throws the 403 the API contract defines. */
function assertPermission(actor, permission) {
  if (!actor) throw fail('UNAUTHENTICATED', 'Sign in to continue.');
  if (can(actor, permission)) return;

  console.warn(
    `[authz] denied "${permission}" for "${actor.username}" (role ${actor.role}, company ${actor.companyId ?? 'platform'})`
  );
  throw fail('INSUFFICIENT_PERMISSION', 'You do not have permission to perform this action.');
}

/**
 * The company a write should be attributed to.
 *
 * A company-scoped actor gets their own, always - a companyId in the request
 * body is ignored outright rather than validated, because the only correct
 * value is one the client cannot influence. A platform actor must name one,
 * since they have no company of their own to fall back to.
 */
function resolveTargetCompany(actor, requestedCompanyId) {
  if (!actor.isPlatform) return actor.companyId;

  const id = Number(requestedCompanyId);
  if (!Number.isInteger(id) || id <= 0) {
    throw fail('VALIDATION_ERROR', 'companyId is required: a platform account must say which company this is for.');
  }
  return id;
}

/**
 * Refuses a resource that belongs to another company.
 *
 * This is the check that makes changing an id in a URL useless. Every route
 * that loads a record by id calls it - or calls a service function that does -
 * before the record is read out or written to.
 */
function assertCompanyMatch(actor, resourceCompanyId, what = 'That record') {
  if (actor.isPlatform) return;
  if (resourceCompanyId !== null && Number(resourceCompanyId) === Number(actor.companyId)) return;

  console.warn(
    `[authz] tenant denial: "${actor.username}" (company ${actor.companyId}) reached ` +
    `a resource in company ${resourceCompanyId ?? 'platform'}`
  );
  throw fail('TENANT_ACCESS_DENIED', `${what} does not belong to your company.`);
}

/**
 * A `WHERE` fragment restricting a query to the actor's company.
 *
 * Returned as a clause plus params rather than an interpolated string so a
 * caller cannot accidentally build it by concatenation, and so the platform
 * case (no restriction) is expressed as an always-true clause instead of
 * needing every call site to branch.
 */
function companyScope(actor, column) {
  if (actor.isPlatform) return { clause: '1 = 1', params: [] };
  return { clause: `${column} = ?`, params: [actor.companyId] };
}

/**
 * Whether `actor` may act on `targetRole`, and what company that implies.
 *
 * Three rules, all of them about not letting a company administrator climb out
 * of their company:
 *
 *   - only a platform account may create or touch another platform account, so
 *     SUPER_ADMIN cannot be minted from inside a company;
 *   - a company account may not assign a platform role, for the same reason;
 *   - a company account may not manage a peer administrator, because two
 *     COMPANY_ADMINs who can deactivate each other are one argument away from a
 *     company with no administrator at all.
 */
function assertCanAssignRole(actor, targetRole) {
  const scope = ROLE_SCOPE_BY_NAME.get(targetRole);
  if (!scope) throw fail('VALIDATION_ERROR', `Unknown role: "${targetRole}"`);
  if (scope === ROLE_SCOPES.platform && !actor.isPlatform) {
    throw fail('INSUFFICIENT_PERMISSION', `Only a platform administrator can assign the ${targetRole} role.`);
  }
  return scope;
}

/** Refuses an action aimed at an account the actor is not allowed to manage. */
function assertCanManageUser(actor, target) {
  if (target.id === actor.id) {
    // Self-service lives on /api/auth. Letting the admin endpoints touch the
    // caller's own row is how an administrator deletes or demotes themselves.
    throw fail('VALIDATION_ERROR', 'Use your profile to change your own account.');
  }

  const targetScope = ROLE_SCOPE_BY_NAME.get(target.role);
  if (targetScope === ROLE_SCOPES.platform && !actor.isPlatform) {
    throw fail('TENANT_ACCESS_DENIED', 'That account is not yours to manage.');
  }

  assertCompanyMatch(actor, target.company_id, 'That account');

  if (!actor.isPlatform && target.role !== 'USER' && target.role !== actor.role) {
    // Reached only if a fourth company role is ever added; stated rather than
    // assumed, so the rule does not quietly widen.
    throw fail('TENANT_ACCESS_DENIED', 'That account is not yours to manage.');
  }
  if (!actor.isPlatform && target.role === actor.role) {
    throw fail(
      'TENANT_ACCESS_DENIED',
      'Another administrator of this company can only be managed by the platform owner.'
    );
  }
}

/**
 * Rejects a permission set that would give a company-scoped role a platform
 * capability. Called before any role's permissions are written.
 */
function assertRolePermissionsAllowed(roleScope, permissions) {
  if (roleScope === ROLE_SCOPES.platform) return;
  const escaping = permissions.filter((p) => PLATFORM_ONLY_PERMISSIONS.has(p));
  if (escaping.length) {
    throw fail(
      'VALIDATION_ERROR',
      `A company role cannot hold platform permissions: ${escaping.join(', ')}`,
      { permissions: escaping }
    );
  }
}

module.exports = {
  buildActor,
  can,
  assertPermission,
  resolveTargetCompany,
  assertCompanyMatch,
  companyScope,
  assertCanAssignRole,
  assertCanManageUser,
  assertRolePermissionsAllowed,
};
