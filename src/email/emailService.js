const { EMAIL_FROM } = require('../config/email');
const { fail } = require('../api/response');

/**
 * The application's only way to send mail.
 *
 * Business code calls `sendEmail({ to, subject, text, html })` and knows nothing
 * about how it leaves the building. Swapping SMTP for SES, SendGrid or Graph is
 * a new file under providers/ and one line here - no change to user creation,
 * and no provider vocabulary anywhere near a route.
 *
 * A provider is a single function with the signature
 *
 *   async send({ from, to, subject, text, html }) -> { id, detail? }
 *
 * and is loaded once, at startup, so a misconfigured transport fails while the
 * process is starting rather than the first time somebody onboards a user.
 *
 * SMTP is the only one. There is deliberately no transport that writes to disk
 * or silently drops a message: every configuration either delivers or fails.
 */

const provider = require('./providers/smtpProvider');

/**
 * Sends one message.
 *
 * A delivery failure is surfaced, never swallowed. Onboarding is the case that
 * matters: an account created with an activation link that was never delivered
 * looks identical, from the admin screen, to one that worked - and the person
 * it was for is left waiting for mail that does not exist.
 */
/**
 * `consequence` is what the caller did about the failure, in the caller's own
 * words - "the company was not created", "the password has been cleared".
 *
 * Only the caller knows: the same delivery failure rolls back a company on one
 * path, a single account on another, and nothing at all on the third. A fixed
 * sentence here was wrong on two of the three, which is worse than silence
 * because the reader has no reason to doubt it.
 */
async function sendEmail(message, { consequence } = {}) {
  const { to, subject, text, html } = message;
  if (!to || !subject || !text) {
    throw new Error('sendEmail requires at least { to, subject, text }');
  }

  try {
    const result = await provider.send({ from: EMAIL_FROM, to, subject, text, html });
    // Recipient and subject only. The body of an onboarding message contains a
    // working activation link, and a log file is not where that belongs.
    console.log(`[email] sent "${subject}" to ${to}${result && result.detail ? ` (${result.detail})` : ''}`);
    return result;
  } catch (err) {
    console.error(`[email] delivery to ${to} failed: ${err.message}`);
    throw fail(
      'EMAIL_DELIVERY_FAILED',
      [
        `The email to ${to} could not be sent.`,
        consequence,
        'Check the mail configuration and try again.',
      ].filter(Boolean).join(' ')
    );
  }
}

/** Reported by the health endpoint so a deployment can confirm what is configured. */
function describeTransport() {
  return { provider: 'smtp', from: EMAIL_FROM };
}

module.exports = { sendEmail, describeTransport };
