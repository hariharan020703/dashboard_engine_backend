require('./env');
const { required, optional, integer, boolean, ConfigError } = require('./configError');

/**
 * Mail transport configuration, read from the environment.
 *
 * SMTP is the only provider. An earlier build also had a "file" transport that
 * wrote messages to disk for development; it is gone, so there is no
 * configuration in which the application reports success for an email that was
 * never actually sent.
 *
 * These settings stay in the environment rather than in src/config/appConfig.js
 * with the other fixed values, because SMTP_PASSWORD is a live credential. An
 * application-specific password grants ongoing send access to a real mailbox
 * for as long as it is valid - unlike the bootstrap account password, which is
 * spent the first time somebody signs in. That belongs alongside the signing
 * secrets, not in version control.
 *
 * Everything is validated here, at require time, so a half-filled configuration
 * is a startup crash naming the variable rather than a failed onboarding hours
 * later.
 */

const SMTP_HOST = required(
  'SMTP_HOST',
  'the mail relay that sends onboarding and activation email, e.g. smtp.gmail.com'
);
const SMTP_PORT = integer('SMTP_PORT', 587, { min: 1, max: 65535 });

/**
 * Implicit TLS (port 465) versus STARTTLS (587 and most others).
 *
 * Derived from the port so the two common cases need no extra setting, and
 * overridable for relays that do something else.
 */
const SMTP_SECURE = boolean('SMTP_SECURE', SMTP_PORT === 465);

const SMTP_USERNAME = optional('SMTP_USERNAME', null);
const SMTP_PASSWORD = optional('SMTP_PASSWORD', null);

// An authenticated relay needs both halves; one alone is always a mistake.
if (Boolean(SMTP_USERNAME) !== Boolean(SMTP_PASSWORD)) {
  throw new ConfigError(
    'SMTP_USERNAME and SMTP_PASSWORD must be set together, or both left blank for an ' +
    'unauthenticated relay.'
  );
}

/**
 * The From address on every message.
 *
 * Defaults to the authenticating mailbox, which is what most providers require
 * anyway - Gmail rewrites or rejects a From that is not the authenticated
 * account or one of its verified aliases.
 */
const EMAIL_FROM = optional('EMAIL_FROM', null) || SMTP_USERNAME;

if (!EMAIL_FROM) {
  throw new ConfigError(
    'No From address: set EMAIL_FROM, or SMTP_USERNAME for it to default to.'
  );
}

module.exports = {
  EMAIL_PROVIDER: 'smtp',
  EMAIL_FROM,
  // Printed in onboarding email so a recipient has somewhere to ask. Optional:
  // a deployment with no support desk should say nothing rather than invent one.
  SUPPORT_EMAIL: optional('SUPPORT_EMAIL', null),
  smtp: {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    user: SMTP_USERNAME,
    password: SMTP_PASSWORD,
  },
};
