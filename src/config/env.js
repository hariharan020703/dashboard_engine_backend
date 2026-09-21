const path = require('path');

/**
 * Single place where the environment is loaded and the project's directory
 * roots are resolved. Required first by every entry point (server, scripts) so
 * process.env is populated before any module reads it.
 *
 * Node's module cache means dotenv runs exactly once regardless of how many
 * modules require this file.
 */

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const PROJECT_ROOT = path.resolve(BACKEND_ROOT, '..');

require('dotenv').config({ path: path.join(BACKEND_ROOT, '.env') });

const LOGS_DIR = path.join(BACKEND_ROOT, 'logs');

module.exports = {
  BACKEND_ROOT,
  PROJECT_ROOT,
  // Frontend build output served by the API process. Vite copies frontend/public
  // into this directory at build time, so it is the only static root needed.
  DIST_DIR: path.join(PROJECT_ROOT, 'frontend', 'dist'),
  // Dashboard metadata (runtime configuration, not source).
  DASHBOARD_CONFIG_DIR: path.join(BACKEND_ROOT, 'config', 'dashboards'),
  // RBAC runtime configuration: the row-level scope dimensions an admin may
  // assign. Same "config, not source" rule as the dashboard directory.
  RBAC_CONFIG_DIR: path.join(BACKEND_ROOT, 'config', 'rbac'),
  // Append-only audit trail for logins and RBAC changes.
  LOGS_DIR,
  // Where the "file" email provider writes rendered messages in development.
  MAIL_OUTBOX_DIR: path.join(LOGS_DIR, 'outbox'),
};
