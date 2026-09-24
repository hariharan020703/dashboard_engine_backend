const crypto = require('crypto');
const {
  COOKIE_SECURE,
  COOKIE_SAMESITE,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} = require('../config/auth');
const { fail } = require('../api/response');

/**
 * The session cookies, and the CSRF defence that comes with them.
 *
 * Both tokens travel as HttpOnly cookies and never in a response body. A token
 * in a body has to be held by JavaScript to be sent back, and anything script
 * can hold, a cross-site scripting bug can read and send somewhere else. An
 * HttpOnly cookie is attached by the browser and cannot be read by any script
 * on the page, including ours - so neither half of the session is ever in
 * JavaScript's reach.
 *
 *   da_access   the short-lived access token, Path=/api, so it reaches every
 *               API endpoint and nothing else (not the SPA, not /svc/*).
 *   da_refresh  the long-lived refresh token, Path=/api/auth, so it reaches
 *               only the endpoints that consume it.
 *   da_csrf     readable by script, on purpose - see below.
 *
 * What that costs, and how it is paid:
 *
 *   A cookie is sent by the browser automatically, including on requests a
 *   third-party page caused - which is what CSRF is. Two things close that:
 *
 *     SameSite=Strict  browsers do not attach either cookie to cross-site
 *                      requests at all;
 *     double submit    every state-changing request that authenticates from a
 *                      cookie must also carry a header matching da_csrf. A
 *                      cross-site caller can cause the cookie to be sent but
 *                      cannot read da_csrf to set the header. Enforced by
 *                      requireCsrf, on refresh/logout directly and on every
 *                      unsafe method through requireAuth.
 *
 *   Reads (GET/HEAD) are not checked: they change nothing, and SameSite plus
 *   the same-origin policy already stop a third party reading the answer.
 */

const ACCESS_COOKIE = 'da_access';
const REFRESH_COOKIE = 'da_refresh';
const CSRF_COOKIE = 'da_csrf';
const CSRF_HEADER = 'x-csrf-token';

// The access cookie goes to every API route; the refresh cookie only to the
// routes that consume it.
const ACCESS_PATH = '/api';
const REFRESH_PATH = '/api/auth';

function baseCookie(path, maxAgeSeconds) {
  return {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SAMESITE,
    path,
    maxAge: maxAgeSeconds * 1000,
  };
}

/**
 * Writes all three cookies. The CSRF one is deliberately readable by scripts -
 * the client has to echo it in a header, which is the whole mechanism.
 *
 * The access cookie expires with the token inside it, so the browser stops
 * sending it at the same moment the server would stop accepting it, and the
 * client's next call gets a plain 401 that triggers a refresh.
 */
function setSessionCookies(res, { accessToken, refreshToken }) {
  const csrfToken = crypto.randomBytes(32).toString('base64url');

  res.cookie(ACCESS_COOKIE, accessToken, baseCookie(ACCESS_PATH, ACCESS_TOKEN_TTL_SECONDS));
  res.cookie(REFRESH_COOKIE, refreshToken, baseCookie(REFRESH_PATH, REFRESH_TOKEN_TTL_SECONDS));
  res.cookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SAMESITE,
    // Readable from every page of the app, so a reload can pick it up.
    path: '/',
    maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
  });
}

function clearSessionCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { ...baseCookie(ACCESS_PATH, 0), maxAge: undefined });
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie(REFRESH_PATH, 0), maxAge: undefined });
  res.clearCookie(CSRF_COOKIE, {
    httpOnly: false,
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SAMESITE,
    path: '/',
  });
}

function readAccessCookie(req) {
  return (req.cookies && req.cookies[ACCESS_COOKIE]) || null;
}

function readRefreshCookie(req) {
  return (req.cookies && req.cookies[REFRESH_COOKIE]) || null;
}

/**
 * Double-submit check for cookie-authenticated, state-changing requests.
 *
 * Compared in constant time. The values are not secret in the way a password
 * is, but a timing oracle on a token comparison is free to avoid and awkward to
 * argue about later.
 */
function requireCsrf(req, res, next) {
  const cookie = req.cookies && req.cookies[CSRF_COOKIE];
  const header = req.get(CSRF_HEADER);

  if (!cookie || !header) {
    return next(fail('CSRF_TOKEN_INVALID', 'This request could not be verified. Reload the page and try again.'));
  }

  const a = Buffer.from(String(cookie));
  const b = Buffer.from(String(header));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return next(fail('CSRF_TOKEN_INVALID', 'This request could not be verified. Reload the page and try again.'));
  }
  next();
}

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  setSessionCookies,
  clearSessionCookies,
  readAccessCookie,
  readRefreshCookie,
  requireCsrf,
};
