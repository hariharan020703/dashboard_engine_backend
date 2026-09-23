require('./env');
const { createPool, quoteIdentifier } = require('./pgPool');
const { required, optional, integer } = require('./configError');

/**
 * The application's one PostgreSQL connection pool.
 *
 * Everything shares it: the query engine reading reporting tables, and the
 * RBAC layer reading accounts, companies, grants and sessions. One database,
 * one set of credentials, one pool.
 *
 * This is a deliberate simplification of an earlier arrangement that kept the
 * metadata in a second database with its own credentials, where a connection
 * literally could not reach the auth tables. That guarantee is gone: anything
 * holding these credentials can read `users` and `refresh_tokens`. What
 * remains is that password hashes are bcrypt, and refresh and activation
 * tokens are stored as HMACs keyed with a secret that lives outside the
 * database - so a dump of these tables still cannot be replayed on its own.
 *
 * If the separation is ever wanted back, the seam is here: give this module a
 * second pool and point the `T` names at it.
 */

const pool = createPool({
  host: required('DB_HOST', 'the PostgreSQL server this application uses'),
  port: integer('DB_PORT', 5432, { min: 1, max: 65535 }),
  user: required('DB_USER', 'the account the application connects as'),
  password: optional('DB_PASSWORD', ''),
  database: required('DB_NAME', 'the database holding both the reporting tables and app metadata'),
  max: integer('DB_POOL_SIZE', 10, { min: 1, max: 100 }),
  // A dashboard request fans out into several queries; waiting forever on a
  // pool that cannot connect turns a misconfiguration into a hung page.
  connectionTimeoutMillis: integer('DB_CONNECT_TIMEOUT_MS', 10000, { min: 1000 }),
  idleTimeoutMillis: 30000,
});

/**
 * The RBAC tables, quoted once here.
 *
 * Unqualified, so they resolve through the connection's search_path - which is
 * `public` unless the deployment changes it. Reporting tables are addressed
 * separately and are schema-qualified from the dashboard spec, so pointing
 * DB_SCHEMA at a schema of their own keeps the two sets from colliding over a
 * name like `users`.
 */
const q = quoteIdentifier;
const T = {
  companies: q('companies'),
  users: q('users'),
  roles: q('roles'),
  rolePermissions: q('role_permissions'),
  groups: q('groups'),
  groupUsers: q('group_users'),
  companyDashboards: q('company_dashboards'),
  dashboards: q('dashboards'),
  dashboardAccess: q('dashboard_access'),
  groupDashboardAccess: q('group_dashboard_access'),
  userDataScope: q('user_data_scope'),
  refreshTokens: q('refresh_tokens'),
  userTokens: q('user_tokens'),
  loginAttempts: q('login_attempts'),
  permissionSeedLog: q('permission_seed_log'),
};

/** Runs `work` inside a transaction on a dedicated connection. */
function withTransaction(work) {
  return pool.transaction(work);
}

module.exports = { db: pool, T, withTransaction };
