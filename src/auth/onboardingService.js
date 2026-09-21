const { issueActivationToken, activationUrl } = require('./activationService');
const { accountActivation } = require('../email/templates');
const { ACTIVATION_TOKEN_TTL_SECONDS } = require('../config/auth');

/**
 * Turning a freshly created account into an invitation somebody can act on.
 *
 * Two routes onboard people - adding a user to a company, and creating a
 * company together with its first administrator - and both owe the recipient
 * exactly the same thing: a single-use link, the same wording, the same expiry.
 * Keeping that in one place is what stops the two drifting into a pair of
 * almost-identical mails where only one says how long the link lasts.
 */

/**
 * Issues an activation link for `user` and renders the invitation around it.
 *
 * Returns a ready-to-send message rather than sending it, because the caller
 * decides when: the company path writes the company, the account and this token
 * in one transaction and sends after it commits. Sending from inside the
 * transaction would hold a database connection open for as long as the mail
 * server takes to answer, which on a hung relay is minutes.
 *
 * `conn` joins that transaction, so a failure anywhere takes the token with it.
 */
async function prepareInvitation(actor, user, { companyName = null, conn } = {}) {
  const { token } = await issueActivationToken(user.id, actor.id, conn);

  return {
    to: user.email,
    ...accountActivation({
      displayName: user.display_name,
      username: user.username,
      email: user.email,
      // `user.companyName` comes from the join in findUserById and is already
      // right on both paths; the argument is for callers that have the name but
      // not the joined row.
      companyName: companyName || user.companyName || null,
      activationUrl: activationUrl(token),
      ttlSeconds: ACTIVATION_TOKEN_TTL_SECONDS,
      invitedBy: actor.displayName || actor.username,
    }),
  };
}

module.exports = { prepareInvitation };
