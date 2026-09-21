const express = require('express');
const { ok, fail, requireId } = require('../api/response');
const { T, withTransaction } = require('../config/database');
const users = require('../auth/userService');
const companies = require('../auth/companyService');
const {
  resolveTargetCompany,
  assertCanAssignRole,
  assertCanManageUser,
} = require('../auth/authorization');
const { prepareInvitation } = require('../auth/onboardingService');
const { revokeAllForUser } = require('../auth/tokenService');
const { sendEmail } = require('../email/emailService');
const {
  getUserScopes,
  scopeOptions,
  scopeProblem,
  replaceUserScopes,
  ENFORCED: SCOPES_ENFORCED,
} = require('../auth/scopeService');
const { listUserGrants } = require('../auth/accessService');
const { audit, EVENTS } = require('../auth/auditService');
const {
  requireRbac,
  requireAuth,
  requirePasswordCurrent,
  requirePermission,
} = require('../middleware/auth');

/**
 * User administration, plus the row-level scopes attached to a user.
 *
 * Every read goes through a service function that takes `req.actor` and filters
 * by company in SQL, and every write re-loads its target the same way before
 * touching it. Changing an id in the URL therefore reaches a 404, not somebody
 * else's account - and the check is the same one whether the caller is a
 * company administrator or the platform owner.
 */
const router = express.Router();

router.use(requireRbac, requireAuth, requirePasswordCurrent);

/* ------------------------------------------------------------ onboarding --- */

/**
 * Creates the account, issues its activation link and sends it - all or
 * nothing.
 *
 * The account and its token are written in one transaction, and the mail is
 * sent after it commits but before the request returns. If delivery fails the
 * account is removed again, because an account nobody can activate is worse
 * than no account: it holds the username and the email address, so the retry
 * that would fix it fails with a conflict instead.
 */
async function createAndInvite(actor, { companyId, username, email, displayName, role }) {
  const user = await users.createUser({ companyId, username, email, displayName, role });

  let invitation;
  try {
    invitation = await prepareInvitation(actor, user);
  } catch (err) {
    await users.deleteUser(user.id);
    throw err;
  }

  try {
    await sendEmail(invitation, { consequence: 'The account was not created.' });
  } catch (err) {
    await users.deleteUser(user.id);
    throw err;
  }

  return user;
}

/* ------------------------------------------------------------------ reads --- */

// Literal paths are registered before /:id so they are not read as an id.

// GET /api/users/options - id, username and email for pickers, same company only
router.get('/options', requirePermission('user.read'), async (req, res) => {
  ok(res, await users.listUserOptions(req.actor));
});

// GET /api/users/scope-options - the dimensions and values a scope may use
router.get('/scope-options', requirePermission('scope.read'), async (req, res) => {
  ok(res, { enforced: SCOPES_ENFORCED, dimensions: await scopeOptions() });
});

// GET /api/users - the user directory the caller may see
router.get('/', requirePermission('user.read'), async (req, res) => {
  ok(res, await users.listUsers(req.actor, { companyId: req.query.companyId }));
});

// POST /api/users - onboard an account and send its activation email
router.post('/', requirePermission('user.create'), async (req, res) => {
  const { username, email, displayName, role } = req.body || {};

  const targetRole = String(role || '').trim();
  if (!targetRole) throw fail('VALIDATION_ERROR', 'A role is required.');

  const scope = assertCanAssignRole(req.actor, targetRole);

  /*
   * A platform account must name the company; a company account gets its own
   * and any companyId in the body is ignored. That is the difference between
   * validating client input and not trusting it at all.
   */
  const companyId = scope === 'platform'
    ? null
    : resolveTargetCompany(req.actor, (req.body || {}).companyId);

  if (companyId !== null) {
    const company = await companies.requireCompany(req.actor, companyId);
    if (!company.active) {
      throw fail('VALIDATION_ERROR', 'That company is deactivated, so accounts cannot be added to it.');
    }
  }

  const user = await createAndInvite(req.actor, {
    companyId,
    username,
    email,
    displayName,
    role: targetRole,
  });

  audit(EVENTS.USER_CREATED, req.actor, {
    userId: user.id,
    targetUsername: user.username,
    targetEmail: user.email,
    role: user.role,
    companyId,
  });
  ok(res, users.publicUser(user), 201);
});

// GET /api/users/:id - one account
router.get('/:id', requirePermission('user.read'), async (req, res) => {
  const user = await users.requireUserInScope(req.actor, requireId(req.params.id, 'user id'));
  ok(res, users.publicUser(user));
});

/* ----------------------------------------------------------------- writes --- */

/*
 * PATCH /api/users/:id - change the role or display name.
 *
 * Activation, deactivation and reissuing access each have their own endpoint
 * rather than being flags here. They are different capabilities with different
 * permissions and different side effects on live sessions, and folding them
 * into one handler is how one of them ends up guarded by the wrong permission.
 */
router.patch('/:id', requirePermission('user.update'), async (req, res) => {
  const id = requireId(req.params.id, 'user id');
  const target = await users.requireUserInScope(req.actor, id);
  assertCanManageUser(req.actor, target);

  const { role, displayName } = req.body || {};
  const updates = {};
  let roleChanged = false;

  if (role !== undefined && role !== target.role) {
    const newRole = String(role).trim();
    assertCanAssignRole(req.actor, newRole);
    // Re-asserted rather than assumed: moving an account to a platform role
    // would have to strip its company, which is not something this endpoint does.
    users.assertRoleCompanyPairing(newRole, target.company_id);
    updates.role = newRole;
    roleChanged = true;
  }
  if (displayName !== undefined) {
    updates.display_name = displayName ? String(displayName).trim().slice(0, 120) : null;
  }

  await users.updateUserColumns(id, updates);

  /*
   * A role change rewrites what this account may do, and its live access tokens
   * still carry the old role. Ending the sessions is what makes the change take
   * effect now rather than within a token lifetime.
   */
  if (roleChanged) await revokeAllForUser(id, 'role_changed');

  audit(EVENTS.USER_UPDATED, req.actor, {
    userId: id,
    targetUsername: target.username,
    roleChanged,
    newRole: roleChanged ? updates.role : undefined,
  });
  ok(res, users.publicUser(await users.findUserById(id)));
});

// POST /api/users/:id/deactivate - switch an account off and end its sessions
router.post('/:id/deactivate', requirePermission('user.deactivate'), async (req, res) => {
  const id = requireId(req.params.id, 'user id');
  const target = await users.requireUserInScope(req.actor, id);
  assertCanManageUser(req.actor, target);

  if (target.status === 'disabled') {
    throw fail('CONFLICT', 'That account is already deactivated.');
  }

  await users.updateUserColumns(id, { status: 'disabled' });
  await revokeAllForUser(id, 'account_deactivated');

  audit(EVENTS.USER_DEACTIVATED, req.actor, { userId: id, targetUsername: target.username });
  ok(res, users.publicUser(await users.findUserById(id)));
});

/*
 * POST /api/users/:id/activate - switch a deactivated account back on.
 *
 * Only for an account that has a password already. One that never finished
 * onboarding has nothing to sign in with, so it goes back to pending and needs
 * a fresh link instead - which is a different button, and says so.
 */
router.post('/:id/activate', requirePermission('user.activate'), async (req, res) => {
  const id = requireId(req.params.id, 'user id');
  const target = await users.requireUserInScope(req.actor, id);
  assertCanManageUser(req.actor, target);

  if (target.status === 'active') throw fail('CONFLICT', 'That account is already active.');
  if (!target.password_hash) {
    throw fail(
      'CONFLICT',
      'That account has never been activated. Send a new activation link instead.'
    );
  }

  await users.updateUserColumns(id, { status: 'active' });
  audit(EVENTS.USER_ACTIVATED, req.actor, { userId: id, targetUsername: target.username });
  ok(res, users.publicUser(await users.findUserById(id)));
});

/*
 * POST /api/users/:id/activation - reissue the activation link.
 *
 * This is also how an administrator resets access for somebody who has lost it.
 * There is deliberately no "set a temporary password for them" path: a
 * credential two people have seen is not a credential, and this leaves the
 * account with none until its owner sets one.
 */
router.post('/:id/activation', requirePermission('user.update'), async (req, res) => {
  const id = requireId(req.params.id, 'user id');
  const target = await users.requireUserInScope(req.actor, id);
  assertCanManageUser(req.actor, target);

  if (target.status === 'disabled') {
    throw fail('CONFLICT', 'Reactivate the account before sending it a new link.');
  }

  const invitation = await withTransaction(async (conn) => {
    // Back to pending, so the old password stops working the moment a new link
    // is issued. Anything else leaves two ways in during the reset.
    await conn.query(
      `UPDATE ${T.users} SET status = 'pending', password_hash = NULL, must_change_password = FALSE
        WHERE id = ?`,
      [id]
    );
    await revokeAllForUser(id, 'access_reissued', conn);
    return prepareInvitation(req.actor, target, { conn });
  });

  /*
   * The reset has already committed at this point, so a delivery failure
   * leaves the account with no password and no link. That is the safe
   * direction - the old password is what we wanted to stop working - but it
   * is not obvious from the outside, so the message says it outright.
   */
  await sendEmail(invitation, {
    consequence: "This account's password has been cleared, so it cannot be signed into until a link is delivered.",
  });

  audit(EVENTS.USER_ACTIVATION_RESENT, req.actor, { userId: id, targetUsername: target.username });
  ok(res, users.publicUser(await users.findUserById(id)));
});

// DELETE /api/users/:id - remove an account; its grants and scopes cascade
router.delete('/:id', requirePermission('user.delete'), async (req, res) => {
  const id = requireId(req.params.id, 'user id');
  const target = await users.requireUserInScope(req.actor, id);
  assertCanManageUser(req.actor, target);

  await users.deleteUser(id);
  audit(EVENTS.USER_DELETED, req.actor, { userId: id, targetUsername: target.username });
  ok(res, { deleted: true });
});

/* ------------------------------------------------------ access and scopes --- */

// GET /api/users/:id/access - every dashboard grant reaching this account
router.get('/:id/access', requirePermission('access.read'), async (req, res) => {
  const user = await users.requireUserInScope(req.actor, requireId(req.params.id, 'user id'));
  ok(res, await listUserGrants(user.id));
});

// GET /api/users/:id/scope - the account's configured row-level scopes
router.get('/:id/scope', requirePermission('scope.read'), async (req, res) => {
  const user = await users.requireUserInScope(req.actor, requireId(req.params.id, 'user id'));
  ok(res, { userId: user.id, scopes: await getUserScopes(user.id), enforced: SCOPES_ENFORCED });
});

/*
 * PUT /api/users/:id/scope - replace the scopes for the dimensions named in the
 * body: { scopes: { theater: ["Grand", "Odeon"] } }. Dimensions left out keep
 * their current values; an empty array clears one, which reads as unrestricted.
 */
router.put('/:id/scope', requirePermission('scope.update'), async (req, res) => {
  const user = await users.requireUserInScope(req.actor, requireId(req.params.id, 'user id'));

  const { scopes } = req.body || {};
  const problem = scopeProblem(scopes);
  if (problem) throw fail('VALIDATION_ERROR', problem);

  await replaceUserScopes(user.id, scopes);
  audit(EVENTS.USER_SCOPE_UPDATED, req.actor, {
    userId: user.id,
    targetUsername: user.username,
    dimensions: Object.keys(scopes),
  });
  ok(res, { userId: user.id, scopes, enforced: SCOPES_ENFORCED });
});

module.exports = router;
