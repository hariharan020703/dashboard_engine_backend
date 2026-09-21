/** Stamps a start time on the response so handlers can log their own latency. */
function requestTimer(req, res, next) {
  res.locals.start = Date.now();
  next();
}

/** Milliseconds since `requestTimer` ran for this request. */
function elapsed(res) {
  return Date.now() - res.locals.start;
}

module.exports = { requestTimer, elapsed };
