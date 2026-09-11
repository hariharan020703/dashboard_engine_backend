/**
 * Maps the error codes raised by the dashboard registry and query engine onto
 * HTTP status codes. Anything unrecognised is a 500 and is logged.
 */
const STATUS_BY_CODE = {
  INVALID_DASHBOARD_ID: 400,
  DASHBOARD_NOT_FOUND: 404,
  INVALID_FILTER: 400,
};

function sendError(res, err, context) {
  const status = STATUS_BY_CODE[err && err.code] || 500;
  if (status >= 500) console.error(`[API] ${context} failed:`, err.message);
  res.status(status).json({ error: err.message, code: err.code });
}

/** Builds an error that `sendError` turns into a 400. */
function badRequest(message) {
  const err = new Error(message);
  err.code = 'INVALID_FILTER';
  return err;
}

module.exports = { STATUS_BY_CODE, sendError, badRequest };
