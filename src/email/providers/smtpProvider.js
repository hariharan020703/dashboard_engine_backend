const nodemailer = require('nodemailer');
const { smtp } = require('../../config/email');

/**
 * SMTP transport.
 *
 * The only provider-specific file in the codebase. Everything it needs comes
 * from config/email.js, which has already validated it.
 */

const transporter = nodemailer.createTransport({
  host: smtp.host,
  port: smtp.port,
  secure: smtp.secure,
  auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
});

async function send({ from, to, subject, text, html }) {
  const info = await transporter.sendMail({ from, to, subject, text, html });
  return { id: info.messageId, detail: info.response };
}

/**
 * Opens a connection and authenticates without sending anything.
 *
 * Called at startup so bad credentials surface then, rather than as a failed
 * onboarding hours later. Non-fatal by design: a mail server that is briefly
 * down should not stop the analytics API from serving dashboards.
 */
async function verify() {
  await transporter.verify();
}

module.exports = { send, verify };
