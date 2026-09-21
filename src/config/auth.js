require('./env');
const { required, optional, integer, boolean, ConfigError } = require('./configError');
const appConfig = require('./appConfig');

/**
 * Every setting the authentication and authorization layer reads, resolved once
 * and validated at load. No module under src/auth, src/routes or src/middleware
 * touches process.env directly, so the values that decide who can sign in are
 * all visible in one file.
 *
 * Nothing here has a fallback secret. A missing JWT secret used to mean a
 * built-in development value, which is indistinguishable at runtime from a
 * correctly configured deployment and forges every token in the system. Now it
 * is a startup crash naming the variable.
 */

const JWT_ACCESS_SECRET = required(
  'JWT_ACCESS_SECRET',
  'it signs access tokens. Anyone holding it can mint a token for any account.'
);
const JWT_REFRESH_SECRET = required(
  'JWT_REFRESH_SECRET',
  'it keys the HMAC that refresh tokens are stored under, so a database dump alone cannot be replayed.'
);

if (JWT_ACCESS_SECRET === JWT_REFRESH_SECRET) {
  throw new ConfigError(
    'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ: sharing one secret means a stolen ' +
    'access token and a stolen refresh token are interchangeable.'
  );
}

/**
 * The address the application is reached at. Used to build the links in
 * onboarding email, and to decide whether session cookies may be marked Secure.
 * Required rather than derived from the request: a Host header is attacker
 * controlled, and an activation link is the last place to trust one.
 */
const APPLICATION_URL = required(
  'APPLICATION_URL',
  'it is the base address used in onboarding email links, e.g. https://analytics.example.com'
);

let applicationOrigin;
try {
  applicationOrigin = new URL(APPLICATION_URL);
} catch {
  throw new ConfigError(`APPLICATION_URL must be an absolute URL (got "${APPLICATION_URL}")`);
}

module.exports = {
  JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET,
  APPLICATION_URL: APPLICATION_URL.replace(/\/+$/, ''),

  /*
   * Token lifetimes, throttling and the bootstrap owner come from
   * config/appConfig.js rather than the environment: they are product
   * decisions, not deployment ones. Re-exported here so every consumer still
   * has a single place to import auth settings from.
   */
  ACCESS_TOKEN_TTL_SECONDS: appConfig.ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS: appConfig.REFRESH_TOKEN_TTL_SECONDS,
  ACTIVATION_TOKEN_TTL_SECONDS: appConfig.ACTIVATION_TOKEN_TTL_SECONDS,

  /*
   * Secure cookies are the default whenever the application is served over
   * HTTPS, and are overridable only downwards for local http development. A
   * Secure cookie is simply dropped by the browser on a plain-http origin, so
   * getting this wrong presents as "login does nothing" rather than as a
   * warning — hence deriving it rather than asking for it.
   */
  COOKIE_SECURE: boolean('COOKIE_SECURE', applicationOrigin.protocol === 'https:'),
  COOKIE_SAMESITE: optional('COOKIE_SAMESITE', 'strict'),

  BCRYPT_ROUNDS: integer('BCRYPT_ROUNDS', 10, { min: 8, max: 15 }),
  MIN_PASSWORD_LENGTH: integer('MIN_PASSWORD_LENGTH', 8, { min: 8, max: 128 }),

  LOGIN_MAX_ATTEMPTS: appConfig.LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_SECONDS: appConfig.LOGIN_WINDOW_SECONDS,
  LOGIN_LOCKOUT_SECONDS: appConfig.LOGIN_LOCKOUT_SECONDS,

  /**
   * The first SUPER_ADMIN, seeded once into an empty users table.
   *
   * Declared in config/appConfig.js. Checked here rather than trusted: a blank
   * value would seed an account nobody can sign in as, and the failure would
   * not surface until somebody tried.
   */
  bootstrapSuperAdmin() {
    const { username, email, password } = appConfig.BOOTSTRAP_SUPERADMIN;
    if (!username || !email || !password) {
      throw new ConfigError(
        'BOOTSTRAP_SUPERADMIN in config/appConfig.js needs a username, an email and a password.'
      );
    }
    return { username, email, password };
  },
};
