const fs = require('fs');
const path = require('path');
const { RBAC_CONFIG_DIR } = require('../config/env');
const { db, T, withTransaction } = require('../config/database');
const { quoteIdentifier } = require('../query/semanticLayer');

/**
 * Row-level data scopes: which slices of the data a user may see, as opposed to
 * accessService.js which decides which dashboards they may open.
 *
 * STORED AND CONFIGURABLE ONLY. Nothing filters on these yet — the query engine
 * does not know about users, and query/queryCache.js keys results by query
 * alone. Enforcing them means doing BOTH: injecting the predicates during
 * planning, and folding the acting user's scope into the cache key. Doing only
 * the first would serve one user's rows to another out of the cache.
 *
 * Which dimensions exist is runtime configuration, not source, so it lives
 * beside the dashboard JSON in config/rbac/scope-dimensions.json:
 *
 *   {
 *     "dimensions": [
 *       { "dimension": "theater", "label": "Theater",
 *         "table": "cinema_analysis", "column": "Theater Name" }
 *     ]
 *   }
 *
 * `database` is optional and defaults to the connection's own. Values are read
 * from that column with SELECT DISTINCT, so the admin UI can only ever offer
 * values that exist in the data.
 */

const CONFIG_FILE = path.join(RBAC_CONFIG_DIR, 'scope-dimensions.json');

// Dimension keys become primary-key text and appear in config; keep them plain.
const DIMENSION_RE = /^[a-z0-9_]{1,64}$/;
const MAX_SCOPE_VALUE_LENGTH = 120;
// A scope list is a picker, not a dataset — an unbounded DISTINCT on a wide
// column would be a slow query with an unusable result.
const MAX_DISTINCT_VALUES = 500;

/**
 * The configured dimensions, or [] when nothing is configured.
 *
 * Read on every call rather than cached: the file changes about as often as a
 * dashboard JSON does, and a stale allowlist is the kind of thing that only
 * shows up as a confusing 400 after someone edits it.
 */
function loadDimensions() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (err) {
    console.warn(`[rbac] ignoring ${path.basename(CONFIG_FILE)}: ${err.message}`);
    return [];
  }

  const list = Array.isArray(parsed && parsed.dimensions) ? parsed.dimensions : [];
  return list.filter((d) => {
    if (!d || !DIMENSION_RE.test(String(d.dimension || ''))) {
      console.warn(`[rbac] skipping scope dimension with an invalid key: ${JSON.stringify(d)}`);
      return false;
    }
    if (!d.table || !d.column) {
      console.warn(`[rbac] scope dimension "${d.dimension}" needs both "table" and "column"`);
      return false;
    }
    return true;
  });
}

function findDimension(key) {
  return loadDimensions().find((d) => d.dimension === key) || null;
}

/** The values an admin may pick for one dimension, read from the data itself. */
async function dimensionValues(dimension) {
  const target = dimension.database
    ? `${quoteIdentifier(dimension.database)}.${quoteIdentifier(dimension.table)}`
    : quoteIdentifier(dimension.table);
  const column = quoteIdentifier(dimension.column);
  const { rows } = await db.query(
    `SELECT DISTINCT ${column} AS value FROM ${target}
      WHERE ${column} IS NOT NULL AND ${column}::text <> ''
      ORDER BY ${column} LIMIT ${MAX_DISTINCT_VALUES}`
  );
  return rows.map((r) => String(r.value));
}

/**
 * Every dimension with its selectable values, for the admin UI.
 * A dimension whose column cannot be read comes back with an empty list and an
 * `error`, so one misconfigured entry does not blank the whole screen.
 */
async function scopeOptions() {
  const out = [];
  for (const dimension of loadDimensions()) {
    try {
      out.push({
        dimension: dimension.dimension,
        label: dimension.label || dimension.dimension,
        values: await dimensionValues(dimension),
      });
    } catch (err) {
      console.warn(`[rbac] scope dimension "${dimension.dimension}" is unreadable: ${err.message}`);
      out.push({
        dimension: dimension.dimension,
        label: dimension.label || dimension.dimension,
        values: [],
        error: err.message,
      });
    }
  }
  return out;
}

/**
 * A user's scopes as { dimension: [values] }. An absent key means unrestricted.
 *
 * A read failure propagates rather than returning {}. An empty object is
 * indistinguishable from "no restrictions", so swallowing the error here would
 * turn a database problem into a silent widening of what somebody may see -
 * which is precisely the direction an error must never fail in.
 */
async function getUserScopes(userId) {
  if (!userId) return {};
  const { rows } = await db.query(
    `SELECT dimension, value FROM ${T.userDataScope} WHERE user_id = ? ORDER BY dimension, value`,
    [userId]
  );
  const scopes = {};
  for (const row of rows) {
    (scopes[row.dimension] = scopes[row.dimension] || []).push(row.value);
  }
  return scopes;
}

/** Validates a { dimension: [values] } payload. Returns an error string or null. */
function scopeProblem(scopes) {
  if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) {
    return 'scopes must be an object of dimension -> values[]';
  }
  for (const [key, values] of Object.entries(scopes)) {
    if (!findDimension(key)) return `Unknown scope dimension "${key}"`;
    if (!Array.isArray(values)) return `scopes.${key} must be an array`;
    if (values.some((v) => String(v).length > MAX_SCOPE_VALUE_LENGTH)) {
      return `scopes.${key} contains a value longer than ${MAX_SCOPE_VALUE_LENGTH} characters`;
    }
  }
  return null;
}

/**
 * Replaces the user's scopes for exactly the dimensions named in the payload,
 * leaving any others untouched. An empty array clears that dimension, which
 * reads as "unrestricted" everywhere else.
 */
async function replaceUserScopes(userId, scopes) {
  await withTransaction(async (conn) => {
    for (const [dimension, values] of Object.entries(scopes)) {
      await conn.query(
        `DELETE FROM ${T.userDataScope} WHERE user_id = ? AND dimension = ?`,
        [userId, dimension]
      );
      const unique = [...new Set(values.map((v) => String(v)))];
      if (unique.length) {
        const placeholders = unique.map(() => '(?, ?, ?)').join(', ');
        await conn.query(
          `INSERT INTO ${T.userDataScope} (user_id, dimension, value) VALUES ${placeholders}`,
          unique.flatMap((v) => [userId, dimension, v])
        );
      }
    }
  });
}

module.exports = {
  CONFIG_FILE,
  loadDimensions,
  findDimension,
  scopeOptions,
  getUserScopes,
  scopeProblem,
  replaceUserScopes,
  // Scopes are configured but not applied. Routes report this so a client is
  // never left assuming the data is already filtered.
  ENFORCED: false,
};
