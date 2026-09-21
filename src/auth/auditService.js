const fs = require('fs');
const path = require('path');
const { LOGS_DIR } = require('../config/env');

/**
 * Append-only audit trail for the events that change who can reach what:
 * sign-ins, session events, and every company / user / role / group / grant
 * mutation.
 *
 * Deliberately a file rather than a table. The trail has to survive the thing
 * it audits, and a row in the application's own database is editable by
 * exactly the account an attacker would already hold if any of these events
 * mattered - the more so now that the RBAC tables and the reporting tables
 * share one set of credentials.
 *
 * Writes are best-effort: a failure to audit must never fail the request that
 * was being audited, so the error is logged and swallowed.
 */

const AUDIT_FILE = path.join(LOGS_DIR, 'audit.log');

/**
 * Every event name the application records.
 *
 * Listed rather than passed as free text so the trail stays greppable: one
 * typo'd event name is a category of activity that silently never appears in a
 * search for it.
 */
const EVENTS = {
  LOGIN_SUCCESS: 'login_success',
  LOGIN_FAILED: 'login_failed',
  LOGIN_BLOCKED: 'login_blocked',
  LOGOUT: 'logout',
  SESSION_REFRESHED: 'session_refreshed',
  SESSION_REVOKED: 'session_revoked',
  REFRESH_REUSE_DETECTED: 'refresh_reuse_detected',
  PASSWORD_CHANGED: 'password_changed',
  ACCOUNT_ACTIVATED: 'account_activated',

  COMPANY_CREATED: 'company_created',
  COMPANY_UPDATED: 'company_updated',
  COMPANY_DELETED: 'company_deleted',

  USER_CREATED: 'user_created',
  USER_UPDATED: 'user_updated',
  USER_DELETED: 'user_deleted',
  USER_ACTIVATED: 'user_activated',
  USER_DEACTIVATED: 'user_deactivated',
  USER_ACTIVATION_RESENT: 'user_activation_resent',
  USER_SCOPE_UPDATED: 'user_scope_updated',

  ROLE_PERMISSIONS_UPDATED: 'role_permissions_updated',

  GROUP_CREATED: 'group_created',
  GROUP_UPDATED: 'group_updated',
  GROUP_DELETED: 'group_deleted',

  DASHBOARD_ASSIGNED: 'dashboard_assigned',
  DASHBOARD_UNASSIGNED: 'dashboard_unassigned',
  DASHBOARD_UPDATED: 'dashboard_updated',
  ACCESS_GRANTED: 'access_granted',
  ACCESS_REVOKED: 'access_revoked',
  ACCESS_DENIED: 'access_denied',
};

const KNOWN_EVENTS = new Set(Object.values(EVENTS));

/**
 * Keys that must never reach the trail, whatever a caller passes in `detail`.
 *
 * The audit log is read by more people than the database is, and is often
 * shipped somewhere central. A credential that lands in it has been published.
 */
const FORBIDDEN_DETAIL_KEYS = new Set([
  'password',
  'newPassword',
  'currentPassword',
  'temporaryPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'activationToken',
  'resetToken',
  'secret',
]);

function scrub(detail) {
  const safe = {};
  for (const [key, value] of Object.entries(detail || {})) {
    if (FORBIDDEN_DETAIL_KEYS.has(key)) {
      safe[key] = '[redacted]';
      console.warn(`[audit] refused to record "${key}" - credentials are never written to the trail`);
      continue;
    }
    if (value !== undefined) safe[key] = value;
  }
  return safe;
}

/**
 * Records one event.
 *
 * `actor` describes who performed it and is written AFTER the detail spread, so
 * a detail key can never overwrite it. Most of these events are about some
 * other account, and an audit line that silently reattributes the action to its
 * target is worse than no line at all.
 */
function audit(event, actor, detail = {}) {
  if (!KNOWN_EVENTS.has(event)) {
    console.warn(`[audit] unknown event "${event}" - add it to EVENTS in auth/auditService.js`);
  }
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const who = actor && typeof actor === 'object'
      ? { actorId: actor.id ?? null, actor: actor.username ?? null, actorCompanyId: actor.companyId ?? null }
      : { actorId: null, actor: String(actor || 'anonymous'), actorCompanyId: null };

    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...scrub(detail), ...who });
    fs.appendFileSync(AUDIT_FILE, line + '\n');
  } catch (err) {
    console.error('[audit] write failed:', err.message);
  }
}

module.exports = { audit, EVENTS, AUDIT_FILE };
