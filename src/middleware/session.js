const crypto = require('crypto');
const { COOKIE_SECURE, COOKIE_SAMESITE, REFRESH_TOKEN_TTL_SECONDS } = require('../config/auth');
const { fail } = require('../api/response');

/**
 * The session cookies, and the CSRF defence that comes with them.
 *
 * Why a cookie at all: a refresh token is the long-lived half of the session,
 * and localStorage is readable by any script that gets onto the page. HttpOnly
 * takes it out of JavaScript's reach entirely, which is the single largest
 * difference this change makes to what a cross-site scripting bug could steal.
 *
 * What that costs, and how it is paid:
 *
 *   A cookie is sent by the browser automatically, including on requests a
 *   third-party page caused - which is what CSRF is. Three things close that:
 *
 *     Path=/api/auth   the cookie is not attached to any other endpoint, so the
 *                      data and admin APIs are unreachable with it;
 *     SameSite=Strict  browsers do not attach it to cross-site requests at all;
 *     double submit    /api/auth/refresh and /api/auth/logout additionally
 *                      require a header matching a second, readable cookie. A
 *                      cross-site caller can cause the cookie to be sent but
 *                      cannot read it to set the header.
 *
 *   Everything else authenticates with a bearer access token, which is never
 *   sent ambiently and therefore cannot be forged this way.
 */

const REFRESH_COOKIE = 'da_refresh';
const CSRF_COOKIE = 'da_csrf';
const CSRF_HEADER = 'x-csrf-token';

// The refresh cookie is scoped to the only routes that consume it.
const REFRESH_PATH = '/api/auth';

function baseCookie(maxAgeSeconds) {
  return {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SAMESITE,
    path: REFRESH_PATH,
    maxAge: maxAgeSeconds * 1000,
  };
}

/**
 * Writes both cookies. The CSRF one is deliberately readable by scripts - the
 * client has to echo it in a header, which is the whole mechanism.
 */
function setSessionCookies(res, refreshToken) {
  const csrfToken = crypto.randomBytes(32).toString('base64url');

  res.cookie(REFRESH_COOKIE, refreshToken, baseCookie(REFRESH_TOKEN_TTL_SECONDS));
  res.cookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SAMESITE,
    // Readable from every page of the app, so a reload can pick it up.
    path: '/',
    maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
  });
  return csrfToken;
}

function clearSessionCookies(res) {
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie(0), maxAge: undefined });
  res.clearCookie(CSRF_COOKIE, {
    httpOnly: false,
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SAMESITE,
    path: '/',
  });
}

function readRefreshCookie(req) {
  return (req.cookies && req.cookies[REFRESH_COOKIE]) || null;
}

/**
 * Double-submit check for the two cookie-authenticated endpoints.
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
  REFRESH_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  setSessionCookies,
  clearSessionCookies,
  readRefreshCookie,
  requireCsrf,
};
