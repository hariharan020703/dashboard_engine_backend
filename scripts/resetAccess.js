require('../src/config/env');
const { db, T, withTransaction } = require('../src/config/database');
const { bootstrapAppMeta } = require('../src/auth/appMetaSchema');
const { issueActivationToken, activationUrl } = require('../src/auth/activationService');
const { revokeAllForUser } = require('../src/auth/tokenService');
const { sendEmail } = require('../src/email/emailService');
const { accountActivation } = require('../src/email/templates');
const { ACTIVATION_TOKEN_TTL_SECONDS } = require('../src/config/auth');

/**
 * Sends an account a fresh activation link from the command line.
 *
 * The API can already do this, but it needs an administrator who can sign in —
 * and the case this script exists for is that nobody can. If the only
 * SUPER_ADMIN loses their password there is otherwise no way back in, because
 * bootstrap only seeds an owner into an empty users table.
 *
 * It does exactly what POST /api/users/:id/activation does, and deliberately no
 * more: it cannot set a password, and it never prints the token. The link goes
 * out through the configured mail transport like any other, so running this
 * does not create a credential that the operator has seen.
 *
 * Usage:
 *   node scripts/resetAccess.js --list
 *   node scripts/resetAccess.js --user admin
 *   node scripts/resetAccess.js --user admin --email newaddress@example.com
 */

function parseArgs(argv) {
  const args = { action: 'list', username: null, email: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--user' || arg === '-u') {
      args.action = 'reset';
      args.username = argv[++i];
    } else if (arg === '--email') {
      args.email = argv[++i];
    } else if (arg === '--list' || arg === '-l') {
      args.action = 'list';
    } else if (arg === '--help' || arg === '-h') {
      args.action = 'help';
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

const USAGE = `
Send an account a fresh activation link, without needing an API token.

  node scripts/resetAccess.js --list                 list every account
  node scripts/resetAccess.js --user <username>      email them a new link
  node scripts/resetAccess.js --user <username> --email <address>

The link lets them set their own password. This script never sets one, and never
prints the token - it is emailed through the configured SMTP relay.
`;

async function list() {
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.email, u.role, u.status, c.name AS company
       FROM ${T.users} u
       LEFT JOIN ${T.companies} c ON c.id = u.company_id
      ORDER BY c.name NULLS FIRST, u.username`
  );
  if (!rows.length) {
    console.log('No accounts yet. Start the server once with BOOTSTRAP_SUPERADMIN_* set.');
    return;
  }
  console.table(rows.map((r) => ({ ...r, company: r.company || '(platform)' })));
}

async function reset({ username, email }) {
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.email, u.display_name, u.company_id, u.status,
            c.name AS "companyName"
       FROM ${T.users} u
       LEFT JOIN ${T.companies} c ON c.id = u.company_id
      WHERE u.username = ?`,
    [username]
  );
  const user = rows[0];
  if (!user) throw new Error(`No account named "${username}"`);
  if (user.status === 'disabled') {
    throw new Error(`"${username}" is deactivated. Reactivate it before sending a link.`);
  }

  const target = email || user.email;

  const { token } = await withTransaction(async (conn) => {
    if (email) {
      await conn.query(`UPDATE ${T.users} SET email = ? WHERE id = ?`, [
        String(email).trim().toLowerCase(),
        user.id,
      ]);
    }
    // Back to pending, so the old password stops working the moment a new link
    // is issued. Anything else leaves two ways in during the reset.
    await conn.query(
      `UPDATE ${T.users} SET status = 'pending', password_hash = NULL, must_change_password = FALSE
        WHERE id = ?`,
      [user.id]
    );
    await revokeAllForUser(user.id, 'access_reissued_cli', conn);
    return issueActivationToken(user.id, null, conn);
  });

  await sendEmail({
    to: target,
    ...accountActivation({
      displayName: user.display_name,
      username: user.username,
      email: target,
      companyName: user.companyName || null,
      activationUrl: activationUrl(token),
      ttlSeconds: ACTIVATION_TOKEN_TTL_SECONDS,
      invitedBy: null,
    }),
  });

  console.log(`Activation link sent to ${target} for "${user.username}".`);
  console.log('Their previous password no longer works and their sessions have ended.');
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.action === 'help') {
    console.log(USAGE);
    return;
  }

  // Safe to call every time, and it means this works on a database the server
  // has never been started against.
  await bootstrapAppMeta();

  if (args.action === 'reset') await reset(args);
  else await list();
})()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`ERROR  ${e.message}`);
    process.exit(1);
  });
