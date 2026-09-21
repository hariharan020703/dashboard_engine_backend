const { APPLICATION_URL } = require('../config/auth');
const { SUPPORT_EMAIL } = require('../config/email');

/**
 * The messages the platform sends, as content rather than transport.
 *
 * Each template returns { subject, text, html } and nothing else, so it can be
 * handed to any provider. Plain text is authoritative and always complete on
 * its own; the HTML part is a courtesy, and a client that shows only the text
 * loses nothing an account needs.
 */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hours(seconds) {
  const h = Math.round(seconds / 3600);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

const supportLine = SUPPORT_EMAIL
  ? `If you need help, contact ${SUPPORT_EMAIL}.`
  : 'If you need help, contact whoever administers this workspace.';

/**
 * The onboarding email.
 *
 * Carries everything section 9 of the brief asks for: where the application is,
 * which account this is, how to get in, how long that stays true, what to do if
 * it was not expected, and who to ask. What it deliberately does not carry is a
 * password - the link sets one that only the recipient ever sees.
 */
function accountActivation({ displayName, username, email, companyName, activationUrl, ttlSeconds, invitedBy }) {
  const greeting = displayName ? `Hello ${displayName},` : 'Hello,';
  const where = companyName ? ` for ${companyName}` : '';
  const by = invitedBy ? ` by ${invitedBy}` : '';
  const validFor = hours(ttlSeconds);

  const text = [
    greeting,
    '',
    `An account has been created for you${by} on the analytics workspace${where}.`,
    '',
    'Your sign-in details',
    `  Application:  ${APPLICATION_URL}`,
    `  Username:     ${username}`,
    `  Email:        ${email}`,
    '',
    'Set your password to finish',
    `  ${activationUrl}`,
    '',
    `This link works once and expires in ${validFor}. After that, ask your`,
    'administrator to send a new one.',
    '',
    'First sign-in',
    '  1. Open the link above and choose a password.',
    `  2. Sign in at ${APPLICATION_URL} with your username or email.`,
    '  3. You will see the dashboards that have been granted to you.',
    '',
    'Security notice',
    '  Nobody from this workspace will ever ask you for your password. Do not',
    '  forward this email - anyone holding the link can set the password on',
    '  this account. If you were not expecting it, ignore it and tell your',
    '  administrator; the link will expire on its own.',
    '',
    supportLine,
  ].join('\n');

  const html = `
<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.55;color:#1e293b;max-width:560px">
  <p>${escapeHtml(greeting)}</p>
  <p>An account has been created for you${escapeHtml(by)} on the analytics workspace${escapeHtml(where)}.</p>

  <table style="border-collapse:collapse;margin:16px 0">
    <tr><td style="padding:2px 16px 2px 0;color:#64748b">Application</td><td><a href="${escapeHtml(APPLICATION_URL)}">${escapeHtml(APPLICATION_URL)}</a></td></tr>
    <tr><td style="padding:2px 16px 2px 0;color:#64748b">Username</td><td><strong>${escapeHtml(username)}</strong></td></tr>
    <tr><td style="padding:2px 16px 2px 0;color:#64748b">Email</td><td>${escapeHtml(email)}</td></tr>
  </table>

  <p style="margin:24px 0">
    <a href="${escapeHtml(activationUrl)}"
       style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">
      Set your password
    </a>
  </p>
  <p style="color:#64748b;font-size:13px">
    This link works once and expires in ${escapeHtml(validFor)}. If it stops working, ask your administrator to send a new one.
  </p>

  <h3 style="font-size:14px;margin:24px 0 4px">First sign-in</h3>
  <ol style="margin:0;padding-left:20px;color:#334155">
    <li>Open the link above and choose a password.</li>
    <li>Sign in with your username or email.</li>
    <li>You will see the dashboards that have been granted to you.</li>
  </ol>

  <h3 style="font-size:14px;margin:24px 0 4px">Security notice</h3>
  <p style="color:#334155;margin:0">
    Nobody from this workspace will ever ask you for your password. Do not forward this email &mdash;
    anyone holding the link can set the password on this account. If you were not expecting it, ignore it
    and tell your administrator; the link will expire on its own.
  </p>

  <p style="color:#64748b;font-size:13px;margin-top:24px">${escapeHtml(supportLine)}</p>
</div>`.trim();

  return {
    // Not "<company> analytics account": a company called "Acme Analytics"
    // then reads "Your Acme Analytics analytics account is ready".
    subject: companyName
      ? `Your ${companyName} account is ready`
      : 'Your analytics account is ready',
    text,
    html,
  };
}

module.exports = { accountActivation };
