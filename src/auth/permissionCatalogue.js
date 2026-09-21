/**
 * The authorization vocabulary: the three business roles, the permissions they
 * can hold, and what a per-dashboard access level means.
 *
 * Three independent axes, and keeping them separate is what stops authorization
 * logic leaking into controllers:
 *
 *   role scope   - platform-wide, or bounded to one company. Decides whether a
 *                  request may reach another company's rows at all.
 *   permission   - what a user may DO (create users, grant access, read data).
 *                  Granted through the user's role.
 *   access level - what a user may do with ONE dashboard. Granted per user or
 *                  per group, ranked, so the strongest grant wins.
 *
 * Adding a capability is a line here plus a `requirePermission` call on the
 * route that performs it. Nothing checks a role name.
 */

/* ------------------------------------------------------------- role scope --- */

/**
 * PLATFORM roles are not bounded by a company. COMPANY roles are, and every
 * company-scoped query is filtered by the actor's own company id.
 *
 * Authorization reads this, never the role's name, so the boundary is a
 * property of the role row rather than a string comparison repeated in thirty
 * places.
 */
const ROLE_SCOPES = { platform: 'platform', company: 'company' };

/* ------------------------------------------------------------ permissions --- */

/**
 * Every permission a role can hold, as a business capability rather than a
 * screen or a button. The admin UI renders this list directly, so a permission
 * that is not here cannot be granted through the API.
 */
const ALL_PERMISSIONS = [
  { id: 'company.read', label: 'View Companies', description: 'See companies and their details.' },
  { id: 'company.create', label: 'Create Companies', description: 'Onboard a new customer company.' },
  { id: 'company.update', label: 'Update Companies', description: 'Rename a company, or activate and deactivate it.' },
  { id: 'company.delete', label: 'Delete Companies', description: 'Permanently remove a company and everything inside it.' },

  { id: 'user.read', label: 'View Users', description: 'See the user directory and individual accounts.' },
  { id: 'user.create', label: 'Create Users', description: 'Onboard new accounts and send their activation email.' },
  { id: 'user.update', label: 'Update Users', description: 'Change an account’s role, and reissue its activation link.' },
  { id: 'user.delete', label: 'Delete Users', description: 'Permanently remove accounts.' },
  { id: 'user.activate', label: 'Activate Users', description: 'Re-enable a deactivated account.' },
  { id: 'user.deactivate', label: 'Deactivate Users', description: 'Disable an account and end its sessions.' },

  { id: 'role.read', label: 'View Roles', description: 'See the roles and the permissions each one holds.' },
  { id: 'role.update', label: 'Manage Role Permissions', description: 'Change which permissions a role holds.' },

  { id: 'group.read', label: 'View Groups', description: 'See groups and their membership.' },
  { id: 'group.create', label: 'Create Groups', description: 'Create groups within the company.' },
  { id: 'group.update', label: 'Update Groups', description: 'Rename groups and change their membership.' },
  { id: 'group.delete', label: 'Delete Groups', description: 'Delete groups and the access they carry.' },

  { id: 'access.read', label: 'View Access', description: 'See who has been granted which dashboard.' },
  { id: 'access.grant', label: 'Grant Access', description: 'Give a user or group access to a dashboard.' },
  { id: 'access.revoke', label: 'Revoke Access', description: 'Take dashboard access away from a user or group.' },

  { id: 'dashboard.read', label: 'Open Dashboards', description: 'Open a dashboard that has been granted to you.' },
  { id: 'dashboard.update', label: 'Edit Dashboards', description: 'Change the card configuration of a dashboard.' },
  { id: 'dashboard.assign', label: 'Assign Dashboards', description: 'Decide which dashboards a company may use.' },

  { id: 'data.read', label: 'Read Data', description: 'Read the source tables behind a granted dashboard.' },

  { id: 'context.read', label: 'View Connections', description: 'See the warehouse connectors and the connections your company has configured.' },
  { id: 'context.manage', label: 'Manage Connections', description: 'Connect a data warehouse, choose its datasets, and remove a connection.' },

  { id: 'scope.read', label: 'View Data Scopes', description: 'See the row-level scopes assigned to a user.' },
  { id: 'scope.update', label: 'Update Data Scopes', description: 'Assign row-level data scopes to a user.' },
];

const PERMISSION_IDS = ALL_PERMISSIONS.map((p) => p.id);
const ALL_PERMISSION_IDS = new Set(PERMISSION_IDS);

/* ------------------------------------------------------------------ roles --- */

const SUPER_ADMIN = 'SUPER_ADMIN';
const COMPANY_ADMIN = 'COMPANY_ADMIN';
const USER = 'USER';

/**
 * The only three roles the platform has. Seeded at bootstrap; the API can edit
 * what COMPANY_ADMIN and USER hold, but cannot add, rename or remove a role -
 * the business model names exactly these three, and a fourth would have no
 * defined company boundary.
 */
const SYSTEM_ROLES = [
  {
    name: SUPER_ADMIN,
    scope: ROLE_SCOPES.platform,
    description: 'Platform owner. Manages every company, user, role and dashboard assignment.',
  },
  {
    name: COMPANY_ADMIN,
    scope: ROLE_SCOPES.company,
    description: 'Administrator of one company. Manages that company’s users, groups and access.',
  },
  {
    name: USER,
    scope: ROLE_SCOPES.company,
    description: 'Member of one company. Reaches only the resources explicitly granted to them.',
  },
];

const ROLE_NAMES = SYSTEM_ROLES.map((r) => r.name);
const ROLE_SCOPE_BY_NAME = new Map(SYSTEM_ROLES.map((r) => [r.name, r.scope]));

/**
 * Seeded once, on an empty roles table, and editable afterwards for the two
 * company roles.
 *
 * SUPER_ADMIN is deliberately absent: its permissions are answered from the
 * catalogue rather than from the table, so a bad permission edit can never
 * remove the platform's own way back in.
 */
const DEFAULT_ROLE_PERMISSIONS = {
  [COMPANY_ADMIN]: [
    'company.read',
    'user.read', 'user.create', 'user.update', 'user.delete', 'user.activate', 'user.deactivate',
    'role.read',
    'group.read', 'group.create', 'group.update', 'group.delete',
    'access.read', 'access.grant', 'access.revoke',
    'dashboard.read', 'data.read',
    'context.read', 'context.manage',
    'scope.read', 'scope.update',
  ],
  [USER]: ['dashboard.read', 'data.read'],
};

/**
 * Permissions a company-scoped role may never hold, whatever the roles screen
 * is asked to save.
 *
 * These are platform capabilities: creating companies, deciding which
 * dashboards a company may use, editing the permission model itself. Granting
 * one to COMPANY_ADMIN would let a customer's administrator act outside their
 * own company, which is the boundary the whole design exists to hold.
 */
const PLATFORM_ONLY_PERMISSIONS = new Set([
  'company.create',
  'company.update',
  'company.delete',
  'role.update',
  'dashboard.assign',
  'dashboard.update',
]);

/**
 * Old permission id -> its replacement.
 *
 * The vocabulary changed from screen-shaped plurals (`users.view`) to business
 * capabilities (`user.read`) at the same time the roles did. This table is what
 * carries an existing installation's configured permissions across, so an
 * administrator who had deliberately narrowed a role does not silently get the
 * defaults back.
 *
 * An old id with no entry here had no counterpart in the new model and is
 * dropped. `dashboards.share` maps to `access.grant` rather than being dropped
 * because it is the same capability under a clearer name.
 */
const LEGACY_PERMISSION_ALIASES = {
  'users.view': 'user.read',
  'users.create': 'user.create',
  'users.update': 'user.update',
  'users.delete': 'user.delete',
  'groups.view': 'group.read',
  'groups.create': 'group.create',
  'groups.update': 'group.update',
  'groups.delete': 'group.delete',
  'roles.view': 'role.read',
  'roles.update': 'role.update',
  'scopes.view': 'scope.read',
  'scopes.update': 'scope.update',
  'dashboards.view': 'dashboard.read',
  'dashboards.edit': 'dashboard.update',
  'dashboards.share': 'access.grant',
  // Never enforced and the feature was never built.
  'ai.chat.use': null,
  'ai.chat.manage': null,
};

/* ---------------------------------------------------------- access levels --- */

/** Ranked so the strongest grant across a user's groups and direct grants wins. */
const LEVEL_RANK = { view: 1, share: 2, developer: 3, admin: 4 };
const ACCESS_LEVELS = Object.keys(LEVEL_RANK);

const ACCESS_LEVEL_LABELS = {
  view: 'Open the dashboard and use its slicers.',
  share: 'View, plus grant other users in the company access to it.',
  developer: 'Share, plus change the dashboard card configuration.',
  admin: 'Developer, plus full control of the dashboard and its grants.',
};

/** Highest of the given levels, or null when the list is empty. */
function strongestLevel(levels) {
  let best = null;
  for (const level of levels || []) {
    if (!LEVEL_RANK[level]) continue;
    if (!best || LEVEL_RANK[level] > LEVEL_RANK[best]) best = level;
  }
  return best;
}

/** True when `level` is at least as strong as `required`. */
function levelAtLeast(level, required) {
  return Boolean(level) && (LEVEL_RANK[level] || 0) >= (LEVEL_RANK[required] || 0);
}

module.exports = {
  ROLE_SCOPES,
  ALL_PERMISSIONS,
  ALL_PERMISSION_IDS,
  PERMISSION_IDS,
  PLATFORM_ONLY_PERMISSIONS,
  LEGACY_PERMISSION_ALIASES,
  SUPER_ADMIN,
  COMPANY_ADMIN,
  USER,
  SYSTEM_ROLES,
  ROLE_NAMES,
  ROLE_SCOPE_BY_NAME,
  DEFAULT_ROLE_PERMISSIONS,
  LEVEL_RANK,
  ACCESS_LEVELS,
  ACCESS_LEVEL_LABELS,
  strongestLevel,
  levelAtLeast,
};
