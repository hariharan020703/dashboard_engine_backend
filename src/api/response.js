/**
 * The API's response contract: one success shape, one error shape, one list of
 * codes.
 *
 * Every response under /api is either
 *
 *   { "success": true,  "data": ... }
 *   { "success": false, "error": { "code": "...", "message": "...", "details": ... } }
 *
 * so a client never has to tell a payload apart from a failure by inspecting
 * its fields. `code` is the stable part — the frontend branches on it and never
 * on the message, which is free to be rewritten for humans.
 */

/**
 * Every error code the API can return, mapped to its HTTP status.
 *
 * A code that is not here cannot be sent: `fail()` rejects it, so a typo
 * surfaces in development rather than reaching a client as an unrecognised
 * string it then has to guess about.
 */
const ERROR_STATUS = {
  // Authentication
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  TOKEN_EXPIRED: 401,
  INVALID_REFRESH_TOKEN: 401,
  INVALID_ACTIVATION_TOKEN: 400,
  PASSWORD_CHANGE_REQUIRED: 403,
  ACCOUNT_DISABLED: 403,
  ACCOUNT_PENDING_ACTIVATION: 403,
  COMPANY_DISABLED: 403,
  CSRF_TOKEN_INVALID: 403,
  RATE_LIMITED: 429,

  // Authorization
  INSUFFICIENT_PERMISSION: 403,
  TENANT_ACCESS_DENIED: 403,

  // Request
  VALIDATION_ERROR: 400,
  RESOURCE_NOT_FOUND: 404,
  CONFLICT: 409,

  // Dashboards and the query engine
  INVALID_DASHBOARD_ID: 400,
  DASHBOARD_NOT_FOUND: 404,
  INVALID_FILTER: 400,
  // The dashboard exists but the table its spec names cannot be read.
  DASHBOARD_SOURCE_UNAVAILABLE: 503,

  // Warehouse connectors (src/modules/context-layer)
  // A credential the third party refused: the person must replace it.
  CONNECTOR_AUTH_FAILED: 400,
  // The third party could not be reached, or answered something unusable.
  CONNECTOR_UNREACHABLE: 502,

  // Infrastructure
  EMAIL_DELIVERY_FAILED: 502,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

/**
 * Codes whose message is written for the person reading the screen and is safe
 * to show verbatim. Anything else is replaced with a generic message before it
 * leaves the process, so a stack trace, a SQL fragment or a table name cannot
 * reach a browser through an unhandled path.
 *
 * Mostly that is the 4xx codes, but the rule is "did we write this message for
 * a human", not "is the status below 500". The 5xx codes listed below are
 * deliberate, well-worded failures that whoever is looking can act on -
 * unreachable mail, a table a dashboard names but the database does not have -
 * and replacing them with "something went wrong" throws away the only useful
 * thing the response carries.
 */
const DISCLOSED_SERVER_ERRORS = new Set([
  'EMAIL_DELIVERY_FAILED',
  'SERVICE_UNAVAILABLE',
  'DASHBOARD_SOURCE_UNAVAILABLE',
  // Names the host and what it answered. Replacing that with "something went
  // wrong" leaves somebody guessing at a third party's configuration.
  'CONNECTOR_UNREACHABLE',
]);

const SAFE_TO_DISCLOSE = new Set([
  ...Object.keys(ERROR_STATUS).filter((code) => ERROR_STATUS[code] < 500),
  ...DISCLOSED_SERVER_ERRORS,
]);

const GENERIC_MESSAGE = 'Something went wrong on our side. Please try again.';

class ApiError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Builds the error the terminal handler turns into a response.
 * Throwing this is the only supported way for a route to fail.
 */
function fail(code, message, details) {
  if (!ERROR_STATUS[code]) {
    throw new Error(`Unknown API error code "${code}". Add it to ERROR_STATUS in api/response.js.`);
  }
  return new ApiError(code, message, details);
}

/**
 * Serialised here rather than through res.json() so the cost of producing the
 * body can be reported separately from the work before it. Both land in a
 * Server-Timing header, which the browser's Network panel shows per request
 * ("Timing" tab): `app` is time since the request entered the API router
 * (auth, queries, shaping), `ser` is JSON serialisation alone.
 */
function ok(res, data, status = 200) {
  const serStart = process.hrtime.bigint();
  const body = JSON.stringify({ success: true, data });
  const serMs = Number(process.hrtime.bigint() - serStart) / 1e6;

  const timings = [`ser;dur=${serMs.toFixed(2)}`];
  if (res.locals.start) timings.unshift(`app;dur=${Date.now() - res.locals.start}`);
  res.set('Server-Timing', timings.join(', '));

  return res.status(status).type('application/json').send(body);
}

/** Writes the error response for `err`, logging anything that is not a client fault. */
function sendError(res, err, context) {
  const code = err && ERROR_STATUS[err.code] ? err.code : 'INTERNAL_ERROR';
  const status = ERROR_STATUS[code];

  if (status >= 500) {
    // The only place the real cause is recorded. It is deliberately not sent.
    console.error(`[api] ${context} failed:`, err && err.stack ? err.stack : err);
  }

  const body = {
    success: false,
    error: {
      code,
      message: SAFE_TO_DISCLOSE.has(code) ? err.message : GENERIC_MESSAGE,
    },
  };
  if (err && err.details !== undefined) body.error.details = err.details;

  if (res.headersSent) return;
  res.status(status).json(body);
}

/**
 * Parses a route parameter that must be a positive integer id.
 *
 * Every route that takes an :id goes through this. Without it a path like
 * /api/users/abc reaches the database as NaN and comes back as a 500 quoting the
 * database, which is both the wrong status and more than a caller should learn
 * from a typo.
 */
function requireId(value, label = 'id') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw fail('VALIDATION_ERROR', `${label} must be a positive integer`);
  }
  return id;
}

/** Trimmed non-empty string, or a validation error naming the field. */
function requireString(value, label, { max = 255, min = 1 } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < min) throw fail('VALIDATION_ERROR', `${label} is required`);
  if (text.length > max) throw fail('VALIDATION_ERROR', `${label} must be ${max} characters or fewer`);
  return text;
}

module.exports = { ERROR_STATUS, ApiError, fail, ok, sendError, requireId, requireString };
