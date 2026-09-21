/**
 * Settings that live in source rather than in the environment.
 *
 * Two kinds of thing are here, and they are here for different reasons.
 *
 * The TUNING values - token lifetimes, login throttling, query concurrency -
 * belong in source because they are product decisions, not deployment ones.
 * Every environment should agree on how long an access token lives, and a
 * value that can drift per deployment is a value nobody can reason about.
 *
 * The BOOTSTRAP CREDENTIAL is here because this project asked for it here.
 * That is a real trade-off and worth stating plainly rather than burying: it
 * is committed to version control, it stays in the history even after it is
 * changed, and it is identical in every deployment built from this source.
 *
 * What limits the damage is that it is a first-use credential only. It is
 * seeded ONLY into an empty users table, and the account it creates carries
 * must_change_password - so signing in once replaces it, and the value below
 * stops working from that moment.
 *
 * The SMTP app password is deliberately NOT here. It grants ongoing send
 * access to a real mailbox with no equivalent 'first use spends it' property,
 * so it lives in the environment with the signing secrets - see config/email.js.
 */

/* --------------------------------------------------------------- durations --- */

const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Access tokens are short because nothing can revoke one before it expires:
 * a session is ended by revoking its refresh token, and any access token
 * already issued is simply allowed to run out. Fifteen minutes is the window
 * in which a signed-out or demoted account can still make a request.
 */
const ACCESS_TOKEN_TTL_SECONDS = 15 * MINUTE;

/** How long a browser stays signed in without re-entering a password. */
const REFRESH_TOKEN_TTL_SECONDS = 30 * DAY;

/** How long an emailed activation link stays usable. Single-use regardless. */
const ACTIVATION_TOKEN_TTL_SECONDS = 72 * HOUR;

/* ------------------------------------------------------------- throttling --- */

/**
 * Login throttling, counted per identifier rather than per IP: the thing being
 * protected is one account's password, and an address is cheap to rotate.
 *
 * The lockout is short and self-clearing because the same design lets someone
 * lock a colleague out by guessing at their username - an administrator having
 * to intervene would make that a better attack, not a worse one.
 */
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_SECONDS = 15 * MINUTE;
const LOGIN_LOCKOUT_SECONDS = 15 * MINUTE;

/* ----------------------------------------------------------------- engine --- */

/**
 * Maximum simultaneous queries per dashboard request.
 *
 * A dashboard fans out into one query per card and slicer. Unbounded, a single
 * page load could open thirty connections and starve every other request; too
 * low and the page renders serially.
 */
const QUERY_CONCURRENCY = 6;

/* -------------------------------------------------------- bootstrap owner --- */

/**
 * The first SUPER_ADMIN, seeded once into an empty users table.
 *
 * Without it there is no way in: every account is created by an administrator,
 * and the first administrator has nobody to create them. Ignored entirely once
 * any account exists.
 *
 * The password below is a first-use credential, not a lasting one - the seeded
 * account carries must_change_password, so signing in once replaces it.
 */
const BOOTSTRAP_SUPERADMIN = {
  username: 'platformowner',
  email: 'owner@example.com',
  password: 'ChangeMeAtFirstSignIn1!',
};

module.exports = {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  ACTIVATION_TOKEN_TTL_SECONDS,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_SECONDS,
  LOGIN_LOCKOUT_SECONDS,
  QUERY_CONCURRENCY,
  BOOTSTRAP_SUPERADMIN,
};
