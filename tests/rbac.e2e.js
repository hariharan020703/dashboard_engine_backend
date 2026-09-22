/*
 * End-to-end exercise of the RBAC, tenancy, token and onboarding behaviour.
 *
 * Talks to a running server over HTTP exactly as a browser does, including
 * cookies, so what it proves is what a client actually gets - not what a unit
 * test of the same functions would.
 *
 * It starts its own SMTP relay (tests/smtpSink.js) and reads the onboarding
 * email out of it. The application has one mail transport - real SMTP - so the
 * server is pointed at that relay instead of the live one for the run:
 *
 *   # terminal 1 - the server, against a throwaway database and the local relay
 *   DB_NAME=app_e2e PORT=8099 \
 *   SMTP_HOST=127.0.0.1 SMTP_PORT=2525 SMTP_USERNAME= SMTP_PASSWORD= \
 *   EMAIL_FROM=e2e@example.com npm start
 *
 *   # terminal 2 - the suite. DB_NAME again: see below.
 *   DB_NAME=app_e2e npm run test:e2e
 *
 * The suite creates its own reporting table in that database, so the dashboard
 * checks exercise the real query engine rather than being skipped. It does that
 * through the application's own pool, which reads .env - so DB_NAME has to be
 * set on BOTH processes. Setting it only on the server points the fixture at
 * the real database instead, and the fixture refuses rather than dropping a
 * table it did not create.
 *
 * Drop app_e2e between runs: it expects to start from an empty installation.
 *
 * The bootstrap owner's credentials come from config/appConfig.js; the suite
 * reads them from there rather than being told them.
 */
const { startSmtpSink } = require('./smtpSink');
const { createReportingFixture } = require('./reportingFixture');
const { BOOTSTRAP_SUPERADMIN } = require('../src/config/appConfig');
/*
 * Read rather than restated, so the link assertion below follows the same
 * configuration the server built the link from. Hardcoding the URL made this
 * suite fail whenever it ran against a server on a different address, which is
 * a property of the harness rather than of the product.
 */
const { APPLICATION_URL } = require('../src/config/auth');

const BASE = process.env.E2E_BASE || 'http://localhost:8099';
const SINK_PORT = Number(process.env.E2E_SMTP_PORT || 2525);

// Set once the sink is listening; every mail assertion reads from it.
let sink = null;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` -- ${detail}` : ''));
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

/** A browser-ish client: keeps cookies, holds an access token in memory. */
function client(label) {
  return {
    label,
    cookies: new Map(),
    accessToken: null,
    csrfToken: null,
    cookieHeader() {
      return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    absorb(res) {
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const line of raw) {
        const [pair] = line.split(';');
        const idx = pair.indexOf('=');
        const name = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        if (value === '' ) this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
      if (this.cookies.has('da_csrf')) this.csrfToken = this.cookies.get('da_csrf');
    },
    async call(method, url, body, opts = {}) {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (this.accessToken && !opts.noAuth) headers.Authorization = `Bearer ${this.accessToken}`;
      if (this.cookies.size) headers.Cookie = this.cookieHeader();
      if (this.csrfToken && !opts.noCsrf) headers['X-CSRF-Token'] = this.csrfToken;
      if (opts.csrf) headers['X-CSRF-Token'] = opts.csrf;

      const res = await fetch(BASE + url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      this.absorb(res);
      let json = null;
      const text = await res.text();
      if (text) { try { json = JSON.parse(text); } catch { json = null; } }
      return { status: res.status, body: json };
    },
    adopt(payload) {
      if (payload && payload.accessToken) this.accessToken = payload.accessToken;
      if (payload && payload.csrfToken) this.csrfToken = payload.csrfToken;
    },
  };
}

/**
 * The most recent message the relay accepted for this address, decoded.
 *
 * Decoded rather than raw: quoted-printable would otherwise split the
 * activation URL across lines and every assertion about it would fail for a
 * reason that has nothing to do with the application.
 */
function latestEmail(toAddress) {
  const message = sink.lastTo(toAddress);
  return message ? `${message.headers.subject || ''}\n${message.text}` : null;
}

function activationTokenFrom(email) {
  const m = /\/activate\?token=([A-Za-z0-9_-]+)/.exec(email || '');
  return m ? m[1] : null;
}

(async () => {
  sink = await startSmtpSink({ port: SINK_PORT });
  console.log(`SMTP sink listening on 127.0.0.1:${SINK_PORT}`);

  // The RBAC tables and the reporting tables share one database now, so the
  // suite provides its own source table - otherwise every check about a
  // granted dashboard rendering would be untestable.
  const fixture = await createReportingFixture();
  console.log(`reporting fixture: ${fixture.schema}.${fixture.table}, ${fixture.rows} rows`);

  // The account bootstrap seeds, read from the same source the server reads.
  const boot = BOOTSTRAP_SUPERADMIN;

  /* ------------------------------------------------------------------ */
  section('Platform owner: first sign-in requires a password change');

  const owner = client('owner');
  let r = await owner.call('POST', '/api/auth/login', {
    identifier: boot.username,
    password: boot.password,
  });
  check('login succeeds', r.status === 200, JSON.stringify(r.body));
  check('state is PASSWORD_CHANGE_REQUIRED', r.body?.data?.state === 'PASSWORD_CHANGE_REQUIRED');
  check('response carries no refresh token', !JSON.stringify(r.body).includes('da_refresh'));
  check('refresh cookie was set HttpOnly', owner.cookies.has('da_refresh'));
  owner.adopt(r.body.data);

  r = await owner.call('GET', '/api/platform/companies');
  check('blocked from other endpoints until the change', r.status === 403 && r.body?.error?.code === 'PASSWORD_CHANGE_REQUIRED', JSON.stringify(r.body));

  r = await owner.call('POST', '/api/auth/change-password', {
    currentPassword: boot.password,
    newPassword: 'OwnerPass1!',
  });
  check('password change succeeds', r.status === 200, JSON.stringify(r.body));
  check('state becomes AUTHENTICATED', r.body?.data?.state === 'AUTHENTICATED');
  owner.adopt(r.body.data);

  r = await owner.call('GET', '/api/platform/companies');
  check('platform endpoints now reachable', r.status === 200, JSON.stringify(r.body));

  /* ------------------------------------------------------------------ */
  section('Platform owner: companies and company administrators');

  r = await owner.call('POST', '/api/platform/companies', { name: 'No Admin Ltd' });
  check('company without an administrator is refused', r.status === 400 && r.body?.error?.code === 'VALIDATION_ERROR', JSON.stringify(r.body));

  r = await owner.call('POST', '/api/platform/companies', {
    name: 'Alpha Industries',
    admin: { username: 'alpha.admin', email: 'alpha.admin@example.com', displayName: 'Alpha Admin' },
  });
  check('creates company A', r.status === 201, JSON.stringify(r.body));
  const companyA = r.body?.data?.id;
  check('creates company A administrator with it', r.body?.data?.admin?.username === 'alpha.admin', JSON.stringify(r.body?.data));
  check('the administrator holds COMPANY_ADMIN', r.body?.data?.admin?.role === 'COMPANY_ADMIN');
  check('the administrator belongs to the new company', r.body?.data?.admin?.companyId === companyA);
  check('new account is pending', r.body?.data?.admin?.status === 'pending');
  check('response contains no password field', !JSON.stringify(r.body).includes('password_hash') && !('password' in (r.body?.data?.admin || {})));

  r = await owner.call('POST', '/api/platform/companies', {
    name: 'Beta Corp',
    admin: { username: 'beta.admin', email: 'beta.admin@example.com' },
  });
  check('creates company B', r.status === 201, JSON.stringify(r.body));
  const companyB = r.body?.data?.id;

  /*
   * A company is not left behind when the account inside it cannot be written.
   * The username collides, so the whole transaction rolls back - and the proof
   * is that the same company name is still free afterwards.
   */
  r = await owner.call('POST', '/api/platform/companies', {
    name: 'Rollback Test Ltd',
    admin: { username: 'alpha.admin', email: 'someone.else@example.com' },
  });
  check('duplicate administrator is refused', r.status === 409 && r.body?.error?.code === 'CONFLICT', JSON.stringify(r.body));

  r = await owner.call('GET', '/api/platform/companies');
  check('the rejected company was not created', !(r.body?.data || []).some((c) => c.name === 'Rollback Test Ltd'), JSON.stringify(r.body));

  r = await owner.call('PUT', `/api/platform/companies/${companyA}/dashboards/default`);
  check('assigns the dashboard to company A', r.status === 200, JSON.stringify(r.body));

  /* ------------------------------------------------------------------ */
  section('Onboarding email and activation');

  const mail = latestEmail('alpha.admin@example.com');
  check('activation email was written', Boolean(mail));
  check('email contains the application URL', (mail || '').includes(APPLICATION_URL), APPLICATION_URL);
  check('email contains the username', (mail || '').includes('alpha.admin'));
  check('email contains a security notice', /Security notice/i.test(mail || ''));
  check('email contains first-login instructions', /First sign-in/i.test(mail || ''));
  check('email contains no password', !/password:\s*\S/i.test(mail || ''));

  const alphaToken = activationTokenFrom(mail);
  check('email contains an activation link', Boolean(alphaToken));

  const alphaAdmin = client('alphaAdmin');
  r = await alphaAdmin.call('GET', `/api/auth/activation?token=${encodeURIComponent(alphaToken)}`);
  check('activation link describes the account', r.status === 200 && r.body?.data?.username === 'alpha.admin', JSON.stringify(r.body));

  r = await alphaAdmin.call('POST', '/api/auth/activation', { token: alphaToken, password: 'short' });
  check('weak password is rejected', r.status === 400 && r.body?.error?.code === 'VALIDATION_ERROR');

  r = await alphaAdmin.call('POST', '/api/auth/activation', { token: alphaToken, password: 'AlphaAdmin1!' });
  check('activation sets the password and signs in', r.status === 200 && r.body?.data?.state === 'AUTHENTICATED', JSON.stringify(r.body));
  alphaAdmin.adopt(r.body.data);

  const replay = client('replay');
  r = await replay.call('POST', '/api/auth/activation', { token: alphaToken, password: 'Another1!' });
  check('activation link is single use', r.status === 400 && r.body?.error?.code === 'INVALID_ACTIVATION_TOKEN', JSON.stringify(r.body));

  /* ------------------------------------------------------------------ */
  section('Company administrator: scoped to their own company');

  r = await alphaAdmin.call('GET', '/api/users');
  check('sees only their company', r.status === 200 && r.body.data.every((u) => u.companyId === companyA), JSON.stringify(r.body?.data?.map((u) => u.username)));

  // The tenant namespace answers about the caller's own company, and takes no
  // company id at all - so there is nothing here to point at another tenant.
  r = await alphaAdmin.call('GET', '/api/workspace/company');
  check('reads their own company', r.status === 200 && r.body.data?.id === companyA, JSON.stringify(r.body));

  r = await alphaAdmin.call('GET', '/api/workspace/overview');
  check('own-company counts are scoped to them', r.status === 200 && r.body.data?.company?.id === companyA, JSON.stringify(r.body));

  // The whole platform namespace is refused on role scope, before any
  // permission is consulted.
  r = await alphaAdmin.call('GET', '/api/platform/companies');
  check('cannot list every company', r.status === 403 && r.body?.error?.code === 'TENANT_ACCESS_DENIED', JSON.stringify(r.body));

  r = await alphaAdmin.call('POST', '/api/platform/companies', { name: 'Sneaky Ltd' });
  check('cannot create a company', r.status === 403 && r.body?.error?.code === 'TENANT_ACCESS_DENIED', JSON.stringify(r.body));

  r = await alphaAdmin.call('GET', '/api/platform/users');
  check('cannot read the cross-tenant directory', r.status === 403 && r.body?.error?.code === 'TENANT_ACCESS_DENIED', JSON.stringify(r.body));

  r = await alphaAdmin.call('POST', '/api/users', {
    username: 'alpha.user', email: 'alpha.user@example.com', role: 'USER',
  });
  check('creates a user in their company', r.status === 201, JSON.stringify(r.body));
  const alphaUserId = r.body?.data?.id;
  check('created user is placed in the admin company', r.body?.data?.companyId === companyA);

  r = await alphaAdmin.call('POST', '/api/users', {
    companyId: companyB, username: 'cross.user', email: 'cross@example.com', role: 'USER',
  });
  check('companyId in the body is ignored, not honoured', r.status === 201 && r.body?.data?.companyId === companyA, JSON.stringify(r.body?.data));
  const ignoredId = r.body?.data?.id;
  if (ignoredId) await alphaAdmin.call('DELETE', `/api/users/${ignoredId}`);

  r = await alphaAdmin.call('POST', '/api/users', {
    username: 'wannabe', email: 'wannabe@example.com', role: 'SUPER_ADMIN',
  });
  check('cannot create a SUPER_ADMIN', r.status === 403 && r.body?.error?.code === 'INSUFFICIENT_PERMISSION', JSON.stringify(r.body));

  // Find company B's admin id by asking as the owner, then try to reach it.
  r = await owner.call('GET', `/api/platform/users?companyId=${companyB}`);
  const betaAdminId = r.body.data.find((u) => u.username === 'beta.admin').id;

  r = await alphaAdmin.call('GET', `/api/users/${betaAdminId}`);
  check('another company\u2019s user is a 404, not a 403', r.status === 404 && r.body?.error?.code === 'RESOURCE_NOT_FOUND', JSON.stringify(r.body));

  r = await alphaAdmin.call('PATCH', `/api/users/${betaAdminId}`, { role: 'USER' });
  check('cannot modify another company\u2019s user', r.status === 404, JSON.stringify(r.body));

  r = await alphaAdmin.call('DELETE', `/api/users/${betaAdminId}`);
  check('cannot delete another company\u2019s user', r.status === 404);

  r = await owner.call('GET', '/api/platform/users');
  const ownerId = r.body.data.find((u) => u.role === 'SUPER_ADMIN').id;
  r = await alphaAdmin.call('PATCH', `/api/users/${ownerId}`, { role: 'USER' });
  check('cannot manage the platform owner', r.status === 404 || r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);

  /* ------------------------------------------------------------------ */
  section('Dashboard access and tenant isolation of data');

  r = await alphaAdmin.call('GET', '/api/access/dashboards');
  check('admin sees the assigned dashboard', r.status === 200 && r.body.data.some((d) => d.id === 'default'), JSON.stringify(r.body?.data));

  r = await alphaAdmin.call('PUT', `/api/access/dashboards/default/users/${alphaUserId}`, { level: 'view' });
  check('grants the dashboard to their user', r.status === 200, JSON.stringify(r.body));

  const betaAdmin = client('betaAdmin');
  const betaToken = activationTokenFrom(latestEmail('beta.admin@example.com'));
  r = await betaAdmin.call('POST', '/api/auth/activation', { token: betaToken, password: 'BetaAdmin1!' });
  check('company B administrator activates', r.status === 200, JSON.stringify(r.body));
  betaAdmin.adopt(r.body.data);

  r = await betaAdmin.call('GET', '/api/dashboard/default');
  check('company B cannot read the unassigned dashboard', r.status === 404 && r.body?.error?.code === 'DASHBOARD_NOT_FOUND', `${r.status} ${JSON.stringify(r.body)}`);

  r = await betaAdmin.call('GET', '/api/access/dashboards');
  check('company B has no dashboards listed', r.status === 200 && r.body.data.length === 0);

  r = await betaAdmin.call('PUT', `/api/access/dashboards/default/users/${alphaUserId}`, { level: 'admin' });
  check('company B cannot grant company A\u2019s user', r.status === 404, `${r.status} ${JSON.stringify(r.body)}`);

  /* ------------------------------------------------------------------ */
  section('Plain user: least privilege');

  const alphaUser = client('alphaUser');
  const userToken = activationTokenFrom(latestEmail('alpha.user@example.com'));
  r = await alphaUser.call('POST', '/api/auth/activation', { token: userToken, password: 'AlphaUser1!' });
  check('user activates and is signed in', r.status === 200, JSON.stringify(r.body));
  alphaUser.adopt(r.body.data);

  r = await alphaUser.call('GET', '/api/dashboard/default');
  check('user reads the granted dashboard', r.status === 200 && Array.isArray(r.body?.data?.cards), `${r.status} ${JSON.stringify(r.body?.error)}`);
  check('dashboard view still has cards and slicers', (r.body?.data?.cards || []).length > 0 && Array.isArray(r.body?.data?.slicers));

  r = await alphaUser.call('GET', '/api/users');
  check('user cannot list users', r.status === 403 && r.body?.error?.code === 'INSUFFICIENT_PERMISSION');

  r = await alphaUser.call('POST', '/api/users', { username: 'x.y', email: 'x@y.com', role: 'USER' });
  check('user cannot create users', r.status === 403);

  r = await alphaUser.call('GET', '/api/workspace/company');
  check('user cannot read their own company either', r.status === 403 && r.body?.error?.code === 'INSUFFICIENT_PERMISSION', JSON.stringify(r.body));

  r = await alphaUser.call('GET', '/api/platform/companies');
  check('user cannot reach the platform namespace', r.status === 403 && r.body?.error?.code === 'TENANT_ACCESS_DENIED', JSON.stringify(r.body));

  r = await alphaUser.call('PUT', '/api/platform/roles/USER/permissions', { permissions: [] });
  check('user cannot edit role permissions', r.status === 403);

  r = await alphaUser.call('PATCH', '/api/dashboard/default/config', { index: 0, card: {} });
  check('user cannot edit the dashboard', r.status === 403, `${r.status} ${JSON.stringify(r.body?.error)}`);

  r = await alphaUser.call('POST', '/api/dashboard/preview', { dashboardId: 'default', card: {} });
  check('user cannot run an arbitrary preview query', r.status === 403);

  /* ------------------------------------------------------------------ */
  section('Groups: company-scoped membership and inherited access');

  r = await alphaAdmin.call('POST', '/api/groups', { name: 'Finance' });
  check('an admin creates a group in their company', r.status === 201, JSON.stringify(r.body));
  const groupId = r.body?.data?.id;
  check('the group belongs to the admin’s company', r.body?.data?.companyId === companyA);

  // Company B may reuse the name: group names are unique per company, not globally.
  r = await betaAdmin.call('POST', '/api/groups', { name: 'Finance' });
  check('another company may use the same group name', r.status === 201, JSON.stringify(r.body));
  const betaGroupId = r.body?.data?.id;

  r = await alphaAdmin.call('POST', '/api/groups', { name: 'Finance' });
  check('the same name twice in one company is refused', r.status === 409, JSON.stringify(r.body));

  r = await alphaAdmin.call('PUT', `/api/groups/${groupId}`, { userIds: [alphaUserId] });
  check('their own user can be added as a member', r.status === 200, JSON.stringify(r.body));

  // The guard that stops group membership breaching the tenant boundary.
  r = await owner.call('GET', `/api/platform/users?companyId=${companyB}`);
  const betaUserId = r.body.data.find((u) => u.username === 'beta.admin').id;
  r = await alphaAdmin.call('PUT', `/api/groups/${groupId}`, { userIds: [betaUserId] });
  check(
    'a member from another company is refused',
    r.status === 400 && r.body?.error?.code === 'VALIDATION_ERROR',
    JSON.stringify(r.body)
  );

  r = await alphaAdmin.call('GET', `/api/groups/${betaGroupId}`);
  check('another company’s group is a 404', r.status === 404, JSON.stringify(r.body));

  r = await alphaAdmin.call('PUT', `/api/access/dashboards/default/groups/${betaGroupId}`, { level: 'admin' });
  check('another company’s group cannot be granted', r.status === 404, JSON.stringify(r.body));

  // Access reaches the member through the group, without a direct grant.
  await alphaAdmin.call('DELETE', `/api/access/dashboards/default/users/${alphaUserId}`);
  r = await alphaUser.call('GET', '/api/access/dashboards');
  check('the direct grant is gone', r.status === 200 && r.body.data.length === 0, JSON.stringify(r.body?.data));

  r = await alphaAdmin.call('PUT', `/api/access/dashboards/default/groups/${groupId}`, { level: 'view' });
  check('the dashboard is granted to the group', r.status === 200, JSON.stringify(r.body));

  r = await alphaUser.call('GET', '/api/access/dashboards');
  check(
    'the member inherits access through the group',
    r.status === 200 && r.body.data.some((d) => d.id === 'default'),
    JSON.stringify(r.body?.data)
  );

  r = await alphaUser.call('GET', '/api/dashboard/default');
  check('and can read the dashboard', r.status === 200, `${r.status} ${JSON.stringify(r.body?.error)}`);

  // A deactivated group keeps its grant but stops passing it on.
  r = await alphaAdmin.call('PUT', `/api/groups/${groupId}`, { active: false });
  check('the group can be deactivated', r.status === 200, JSON.stringify(r.body));
  r = await alphaUser.call('GET', '/api/dashboard/default');
  check('a deactivated group stops passing access on', r.status === 404, `${r.status} ${JSON.stringify(r.body?.error)}`);

  await alphaAdmin.call('PUT', `/api/groups/${groupId}`, { active: true });
  r = await alphaUser.call('GET', '/api/dashboard/default');
  check('reactivating the group restores it', r.status === 200, `${r.status}`);

  r = await alphaAdmin.call('DELETE', `/api/groups/${groupId}`);
  check('the group can be deleted', r.status === 200, JSON.stringify(r.body));
  r = await alphaUser.call('GET', '/api/dashboard/default');
  check('deleting the group takes the inherited access with it', r.status === 404, `${r.status}`);

  // Put the direct grant back for the sections that follow.
  await alphaAdmin.call('PUT', `/api/access/dashboards/default/users/${alphaUserId}`, { level: 'view' });

  /* ------------------------------------------------------------------ */
  section('Role permissions and the platform boundary');

  r = await owner.call('PUT', '/api/platform/roles/COMPANY_ADMIN/permissions', {
    permissions: ['user.read', 'company.create'],
  });
  check('a company role cannot be given a platform permission', r.status === 400 && r.body?.error?.code === 'VALIDATION_ERROR', JSON.stringify(r.body));

  r = await owner.call('PUT', '/api/platform/roles/SUPER_ADMIN/permissions', { permissions: [] });
  check('SUPER_ADMIN permissions cannot be edited', r.status === 400, JSON.stringify(r.body));

  r = await owner.call('PUT', '/api/platform/roles/USER/permissions', { permissions: ['dashboard.read', 'data.read'] });
  check('USER permissions can be edited', r.status === 200, JSON.stringify(r.body));

  /* ------------------------------------------------------------------ */
  section('Token lifecycle');

  const before = alphaUser.accessToken;
  const beforeCookie = alphaUser.cookies.get('da_refresh');
  r = await alphaUser.call('POST', '/api/auth/refresh');
  check('refresh returns a new access token', r.status === 200 && r.body?.data?.accessToken !== before, JSON.stringify(r.body?.error));
  check('refresh rotates the refresh cookie', alphaUser.cookies.get('da_refresh') !== beforeCookie);
  alphaUser.adopt(r.body.data);

  // Replay the pre-rotation token: reuse detection must revoke the family.
  const thief = client('thief');
  thief.cookies.set('da_refresh', beforeCookie);
  thief.csrfToken = alphaUser.csrfToken;
  thief.cookies.set('da_csrf', alphaUser.csrfToken);
  r = await thief.call('POST', '/api/auth/refresh');
  check('a replayed refresh token is rejected', r.status === 401 && r.body?.error?.code === 'INVALID_REFRESH_TOKEN', JSON.stringify(r.body));

  r = await alphaUser.call('POST', '/api/auth/refresh');
  check('reuse detection revokes the whole family', r.status === 401, `${r.status} ${JSON.stringify(r.body)}`);

  // Sign back in for the remaining checks.
  r = await alphaUser.call('POST', '/api/auth/login', { identifier: 'alpha.user', password: 'AlphaUser1!' });
  check('user can sign in again after the family was revoked', r.status === 200, JSON.stringify(r.body));
  alphaUser.adopt(r.body.data);

  r = await alphaUser.call('POST', '/api/auth/refresh', undefined, { noCsrf: true, csrf: undefined });
  const noCsrf = await (async () => {
    const headers = { Cookie: alphaUser.cookieHeader() };
    const res = await fetch(BASE + '/api/auth/refresh', { method: 'POST', headers });
    return { status: res.status, body: await res.json().catch(() => null) };
  })();
  check('refresh without the CSRF header is refused', noCsrf.status === 403 && noCsrf.body?.error?.code === 'CSRF_TOKEN_INVALID', JSON.stringify(noCsrf.body));

  r = await alphaUser.call('POST', '/api/auth/logout');
  check('logout succeeds', r.status === 200);
  check('logout clears the refresh cookie', !alphaUser.cookies.has('da_refresh'));

  const stale = client('stale');
  stale.cookies.set('da_refresh', beforeCookie);
  stale.cookies.set('da_csrf', 'x');
  stale.csrfToken = 'x';
  r = await stale.call('POST', '/api/auth/refresh');
  check('a revoked refresh token stays rejected', r.status === 401);

  /* ------------------------------------------------------------------ */
  section('Deactivation ends access');

  r = await alphaAdmin.call('POST', `/api/users/${alphaUserId}/deactivate`);
  check('admin deactivates their user', r.status === 200 && r.body?.data?.status === 'disabled', JSON.stringify(r.body));

  const disabled = client('disabled');
  r = await disabled.call('POST', '/api/auth/login', { identifier: 'alpha.user', password: 'AlphaUser1!' });
  check('deactivated account cannot sign in', r.status === 403 && r.body?.error?.code === 'ACCOUNT_DISABLED', JSON.stringify(r.body));

  r = await owner.call('PATCH', `/api/platform/companies/${companyA}`, { active: false });
  check('owner deactivates company A', r.status === 200);

  const blocked = client('blocked');
  r = await blocked.call('POST', '/api/auth/login', { identifier: 'alpha.admin', password: 'AlphaAdmin1!' });
  check('a disabled company blocks its administrator', r.status === 403 && r.body?.error?.code === 'COMPANY_DISABLED', JSON.stringify(r.body));

  r = await alphaAdmin.call('GET', '/api/users');
  check('live session in a disabled company is dropped', r.status === 403 && r.body?.error?.code === 'COMPANY_DISABLED', `${r.status} ${JSON.stringify(r.body)}`);

  await owner.call('PATCH', `/api/platform/companies/${companyA}`, { active: true });

  /* ------------------------------------------------------------------ */
  section('Unauthenticated and malformed requests');

  const anon = client('anon');
  for (const [method, url] of [
    ['GET', '/api/dashboard/default'],
    ['GET', '/api/users'],
    ['GET', '/api/groups'],
    ['GET', '/api/workspace/company'],
    ['GET', '/api/platform/companies'],
    ['GET', '/api/platform/users'],
    ['GET', '/api/platform/audit'],
    ['GET', '/api/dashboard/columns?dashboardId=default'],
    ['POST', '/api/dashboard/preview'],
  ]) {
    r = await anon.call(method, url, method === 'POST' ? {} : undefined, { noAuth: true });
    check(`anonymous ${method} ${url} is refused`, r.status === 401, `${r.status} ${JSON.stringify(r.body)}`);
  }

  r = await anon.call('POST', '/api/auth/login', { identifier: 'alpha.admin', password: 'wrong' }, { noAuth: true });
  check('wrong password gives INVALID_CREDENTIALS', r.status === 401 && r.body?.error?.code === 'INVALID_CREDENTIALS');
  r = await anon.call('POST', '/api/auth/login', { identifier: 'nobody.here', password: 'wrong' }, { noAuth: true });
  check('unknown account gives the same answer', r.status === 401 && r.body?.error?.code === 'INVALID_CREDENTIALS');

  r = await anon.call('GET', '/api/nope', undefined, { noAuth: true });
  check('unknown endpoint is a structured 404', r.status === 404 && r.body?.success === false && r.body?.error?.code === 'RESOURCE_NOT_FOUND');

  r = await owner.call('GET', '/api/platform/users/abc');
  check('a non-numeric id is a validation error', r.status === 400 && r.body?.error?.code === 'VALIDATION_ERROR');

  /* ------------------------------------------------------------------ */
  await sink.stop();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
})().catch(async (err) => {
  if (sink) await sink.stop().catch(() => {});
  console.error('\nHARNESS ERROR:', err);
  process.exit(2);
});
