const { db, T } = require('../config/database');
const {
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_SECONDS,
  LOGIN_LOCKOUT_SECONDS,
} = require('../config/auth');
const { fail } = require('../api/response');

/**
 * Login throttling, counted per identifier.
 *
 * Per identifier rather than per IP because the thing being protected is one
 * account's password, and an address is cheap to rotate while a username is
 * not. The cost is that someone can lock a colleague out by guessing at their
 * username; the lockout is therefore short and self-clearing rather than
 * requiring an administrator.
 *
 * Rows are kept for identifiers that name no account too. Skipping those would
 * make a locked-out response a reliable signal that the username is real.
 *
 * State lives in a table rather than in process memory so it survives a restart
 * and holds across more than one API process.
 */

/** Normalises an identifier to the key the table is counted by. */
function keyFor(identifier) {
  return String(identifier || '').trim().toLowerCase().slice(0, 190);
}

/** Throws when the identifier is currently locked out. Called before any hashing. */
async function assertNotLocked(identifier) {
  const key = keyFor(identifier);
  if (!key) return;

  const { rows } = await db.query(
    `SELECT locked_until FROM ${T.loginAttempts} WHERE identifier = ?`,
    [key]
  );
  const row = rows[0];
  if (!row || !row.locked_until) return;

  const until = new Date(row.locked_until).getTime();
  if (until <= Date.now()) return;

  const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60000));
  throw fail(
    'RATE_LIMITED',
    `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
  );
}

/**
 * Records a failed attempt and locks the identifier once the limit is reached.
 *
 * The counter resets when the window elapses, so ordinary mistyping spread over
 * a day never accumulates into a lockout.
 *
 * The window test is written out three times rather than computed once, because
 * PostgreSQL evaluates every assignment in ON CONFLICT DO UPDATE against the
 * row as it was BEFORE the statement. There is no left-to-right chaining to
 * lean on - `attempts` still reads as the old value while `locked_until` is
 * being computed - so each expression has to decide for itself whether this
 * attempt starts a fresh window or extends the current one.
 */
async function recordFailure(identifier) {
  const key = keyFor(identifier);
  if (!key) return;

  // `$n * interval '1 second'` rather than a literal INTERVAL, because the
  // duration is configuration and an interval literal cannot be parameterised.
  const windowElapsed = `${T.loginAttempts}.window_started_at < now() - (? * interval '1 second')`;
  const nextAttempts = `CASE WHEN ${windowElapsed} THEN 1 ELSE ${T.loginAttempts}.attempts + 1 END`;

  await db.query(
    `INSERT INTO ${T.loginAttempts} (identifier, attempts, window_started_at)
     VALUES (?, 1, now())
     ON CONFLICT (identifier) DO UPDATE SET
       attempts = ${nextAttempts},
       window_started_at = CASE WHEN ${windowElapsed} THEN now()
                                ELSE ${T.loginAttempts}.window_started_at END,
       locked_until = CASE WHEN (${nextAttempts}) >= ?
                           THEN now() + (? * interval '1 second')
                           ELSE ${T.loginAttempts}.locked_until END`,
    [
      key,
      LOGIN_WINDOW_SECONDS, // attempts
      LOGIN_WINDOW_SECONDS, // window_started_at
      LOGIN_WINDOW_SECONDS, // locked_until, inside the repeated attempts test
      LOGIN_MAX_ATTEMPTS,
      LOGIN_LOCKOUT_SECONDS,
    ]
  );
}

/** Clears the counter after a successful sign-in. */
async function recordSuccess(identifier) {
  const key = keyFor(identifier);
  if (!key) return;
  await db.query(`DELETE FROM ${T.loginAttempts} WHERE identifier = ?`, [key]);
}

/** Drops rows whose window and lockout have both long since passed. */
async function pruneAttempts() {
  const result = await db.query(
    `DELETE FROM ${T.loginAttempts}
      WHERE (locked_until IS NULL OR locked_until < now())
        AND window_started_at < now() - interval '1 day'`
  );
  return result.rowCount;
}

module.exports = { assertNotLocked, recordFailure, recordSuccess, pruneAttempts };
