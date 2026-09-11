const path = require('path');

/**
 * Single place where the environment is loaded and the project's directory
 * roots are resolved. Required first by every entry point (server, tests,
 * benchmarks, scripts) so process.env is populated before any module reads it.
 *
 * Node's module cache means dotenv runs exactly once regardless of how many
 * modules require this file.
 */

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const PROJECT_ROOT = path.resolve(BACKEND_ROOT, '..');

require('dotenv').config({ path: path.join(BACKEND_ROOT, '.env') });

module.exports = {
  // Frontend build output served by the API process. Vite copies frontend/public
  // into this directory at build time, so it is the only static root needed.
  DIST_DIR: path.join(PROJECT_ROOT, 'frontend', 'dist'),
  // Dashboard metadata (runtime configuration, not source).
  DASHBOARD_CONFIG_DIR: path.join(BACKEND_ROOT, 'config', 'dashboards'),
};
