const { Pool, types } = require('pg');

/**
 * The one place that knows how the application talks to PostgreSQL.
 *
 * Both pools - the reporting one and the metadata one - are built here, so the
 * driver, the placeholder convention and the type coercions are decided once
 * rather than per module.
 */

/* ------------------------------------------------------- type coercions --- */

/**
 * node-postgres returns BIGINT, NUMERIC and the 64-bit aggregate types as
 * STRINGS by default, because they can hold values a JS number cannot
 * represent exactly. That default is right for a ledger and wrong here: every
 * `COUNT(*)` in this application comes back as int8, and a count arriving as
 * "1234" silently breaks arithmetic, chart scales and `Number.isInteger`
 * guards - quietly, as a string that looks like a number.
 *
 * So they are parsed to Number, with eyes open: values beyond 2^53 lose
 * precision. For row counts and the aggregates this engine computes that
 * threshold is unreachable, and the alternative is every caller remembering to
 * coerce.
 */
const PG_INT8 = 20;
const PG_NUMERIC = 1700;

types.setTypeParser(PG_INT8, (value) => (value === null ? null : Number(value)));
types.setTypeParser(PG_NUMERIC, (value) => (value === null ? null : Number(value)));

/* ------------------------------------------------------- placeholders --- */

/**
 * Rewrites `?` placeholders into PostgreSQL's `$1, $2, …`.
 *
 * Kept because the SQL in this codebase is frequently assembled - IN lists,
 * multi-row inserts, optional WHERE fragments are all built by joining
 * generated placeholders. Numbering those by hand at each call site is exactly
 * where an off-by-one hides, and it fails as a wrong *value* bound to the right
 * position rather than as an error.
 *
 * `?` inside a string literal or a quoted identifier is left alone, so
 * `WHERE note LIKE '%?%'` and a column actually named `?` both survive. The
 * scanner is small because that is the whole grammar it needs: it only has to
 * know when it is inside quotes.
 */
function toPositionalParams(sql) {
  let out = '';
  let index = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      out += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      out += ch;
      if (ch === '*' && next === '/') {
        out += next;
        i++;
        inBlockComment = false;
      }
      continue;
    }
    if (!inSingle && !inDouble && ch === '-' && next === '-') {
      inLineComment = true;
      out += ch;
      continue;
    }
    if (!inSingle && !inDouble && ch === '/' && next === '*') {
      inBlockComment = true;
      out += ch;
      continue;
    }

    if (ch === "'" && !inDouble) {
      // '' inside a string is an escaped quote, not the end of it.
      if (inSingle && next === "'") {
        out += ch + next;
        i++;
        continue;
      }
      inSingle = !inSingle;
      out += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      if (inDouble && next === '"') {
        out += ch + next;
        i++;
        continue;
      }
      inDouble = !inDouble;
      out += ch;
      continue;
    }

    if (ch === '?' && !inSingle && !inDouble) {
      out += `$${++index}`;
      continue;
    }
    out += ch;
  }

  return out;
}

/* -------------------------------------------------------------- pooling --- */

/**
 * Wraps a pg client or pool so `query` accepts `?` placeholders.
 *
 * The same wrapper covers both, which is what lets `withTransaction` hand a
 * client to code that also runs outside a transaction against the pool.
 */
function wrap(client) {
  return {
    query(sql, params) {
      return client.query(toPositionalParams(sql), params || []);
    },
    // Reached for the few statements that must not be rewritten, such as DDL
    // containing a literal question mark.
    raw(sql, params) {
      return client.query(sql, params || []);
    },
  };
}

/**
 * Creates a pool and the small surface the application uses against it.
 *
 * `query` returns node-postgres's own result - `{ rows, rowCount }` - rather
 * than reshaping it. Callers read `.rows`, and `.rowCount` is the honest answer
 * to "did that update anything".
 */
function createPool(config) {
  const pool = new Pool(config);

  // An idle client dying (a database restart, a connection reaper) emits on the
  // pool, and an unhandled 'error' event takes the process down.
  pool.on('error', (err) => {
    console.error(`[db] idle client error on ${config.database || 'postgres'}:`, err.message);
  });

  const wrapped = wrap(pool);

  return {
    query: wrapped.query,
    raw: wrapped.raw,

    /**
     * Runs `work` inside a transaction on one client.
     *
     * Every multi-statement write goes through this. Hand-rolling
     * begin/commit/rollback at each call site was three chances per site to
     * leak a connection, and the rollback was routinely written so that it
     * swallowed the original error along with the one it was reporting.
     */
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        // The failure that started this is the useful one; a rollback that also
        // fails must not replace it.
        try { await client.query('ROLLBACK'); } catch { /* preserve the original */ }
        throw err;
      } finally {
        client.release();
      }
    },

    end: () => pool.end(),
    pool,
  };
}

/**
 * PostgreSQL's SQLSTATE for a unique-constraint violation.
 *
 * Named because `'23505'` at a call site says nothing, and it is checked in
 * half a dozen places to turn a duplicate into a 409 rather than a 500.
 */
const UNIQUE_VIOLATION = '23505';

/** Double-quotes an identifier, escaping any embedded quote. */
function quoteIdentifier(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

module.exports = { createPool, toPositionalParams, quoteIdentifier, UNIQUE_VIOLATION };
