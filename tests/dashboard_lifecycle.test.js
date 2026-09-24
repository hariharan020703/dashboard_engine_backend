const assert = require('assert');
const { db, T } = require('../src/config/database');
const { bootstrapAppMeta } = require('../src/auth/appMetaSchema');
const registry = require('../src/dashboard/dashboardRegistry');
const access = require('../src/auth/accessService');
const {
  DEFAULT_ROLE_PERMISSIONS,
  PLATFORM_ONLY_PERMISSIONS,
  PERMISSION_IDS,
  COMPANY_ADMIN,
  USER,
} = require('../src/auth/permissionCatalogue');

async function runTests() {
  console.log('=== Starting Multi-Tenant Dashboard Architecture Tests ===\n');

  // 1. Verify Permission Catalogue
  console.log('[1] Checking Permission Catalogue Role Bindings:');
  assert(PERMISSION_IDS.includes('dashboard.create'), 'Catalogue must include dashboard.create');
  assert(PERMISSION_IDS.includes('dashboard.update'), 'Catalogue must include dashboard.update');
  assert(PERMISSION_IDS.includes('dashboard.delete'), 'Catalogue must include dashboard.delete');
  assert(PERMISSION_IDS.includes('dashboard.assign'), 'Catalogue must include dashboard.assign');
  console.log('  ✓ Catalogue defines dashboard.create, dashboard.update, dashboard.delete, dashboard.assign');

  const companyAdminPerms = DEFAULT_ROLE_PERMISSIONS[COMPANY_ADMIN];
  const userPerms = DEFAULT_ROLE_PERMISSIONS[USER];

  assert(companyAdminPerms.includes('dashboard.create'), 'COMPANY_ADMIN must have dashboard.create');
  assert(companyAdminPerms.includes('dashboard.update'), 'COMPANY_ADMIN must have dashboard.update');
  assert(companyAdminPerms.includes('dashboard.delete'), 'COMPANY_ADMIN must have dashboard.delete');
  assert(!companyAdminPerms.includes('dashboard.assign'), 'COMPANY_ADMIN must NOT have dashboard.assign');
  console.log('  ✓ COMPANY_ADMIN has create, update, delete; lacks dashboard.assign');

  assert(userPerms.includes('dashboard.create'), 'USER must have dashboard.create');
  assert(userPerms.includes('dashboard.update'), 'USER must have dashboard.update');
  assert(!userPerms.includes('dashboard.delete'), 'USER must NOT have dashboard.delete');
  assert(!userPerms.includes('dashboard.assign'), 'USER must NOT have dashboard.assign');
  console.log('  ✓ USER has create and update; strictly forbidden from delete and assign');

  assert(PLATFORM_ONLY_PERMISSIONS.has('dashboard.assign'), 'dashboard.assign must be PLATFORM_ONLY');
  assert(!PLATFORM_ONLY_PERMISSIONS.has('dashboard.update'), 'dashboard.update must not be platform-only');
  console.log('  ✓ PLATFORM_ONLY_PERMISSIONS correctly confines cross-company assignment\n');

  // 2. Database Schema and Default Seeding
  console.log('[2] Bootstrapping Database Schema:');
  await bootstrapAppMeta();
  console.log('  ✓ bootstrapAppMeta ran successfully');

  const tableCheck = await db.query(
    `SELECT column_name, data_type 
     FROM information_schema.columns 
     WHERE table_name = 'dashboards'`
  );
  assert(tableCheck.rows.length > 0, 'dashboards table must exist');
  const colNames = tableCheck.rows.map((r) => r.column_name);
  assert(colNames.includes('company_id'), 'dashboards must contain company_id');
  assert(colNames.includes('created_by'), 'dashboards must contain created_by');
  assert(colNames.includes('spec'), 'dashboards must contain spec');
  console.log('  ✓ dashboards table has company_id, created_by, spec columns');

  // Verify role_permissions table has dashboard.update for COMPANY_ADMIN and USER
  const rolePermRows = await db.query(
    `SELECT role_name, permission_id FROM ${T.rolePermissions} WHERE permission_id IN ('dashboard.create', 'dashboard.update', 'dashboard.delete')`
  );
  const adminPermsInDb = rolePermRows.rows.filter((r) => r.role_name === COMPANY_ADMIN).map((r) => r.permission_id);
  const userPermsInDb = rolePermRows.rows.filter((r) => r.role_name === USER).map((r) => r.permission_id);
  assert(adminPermsInDb.includes('dashboard.create'), 'COMPANY_ADMIN must have dashboard.create in DB');
  assert(adminPermsInDb.includes('dashboard.update'), 'COMPANY_ADMIN must have dashboard.update in DB');
  assert(adminPermsInDb.includes('dashboard.delete'), 'COMPANY_ADMIN must have dashboard.delete in DB');
  assert(userPermsInDb.includes('dashboard.create'), 'USER must have dashboard.create in DB');
  assert(userPermsInDb.includes('dashboard.update'), 'USER must have dashboard.update in DB');
  assert(!userPermsInDb.includes('dashboard.delete'), 'USER must NOT have dashboard.delete in DB');
  console.log('  ✓ Database role_permissions table verified for COMPANY_ADMIN and USER');

  // 3. Registry DB listing and scoping
  console.log('\n[3] Testing Registry Scoping:');
  const allDashboards = await registry.listDashboards();
  console.log(`  ✓ Found ${allDashboards.length} dashboards in total.`);
  const defaultDashboard = allDashboards.find((d) => d.id === 'default');
  assert(defaultDashboard, 'default dashboard must be seeded');
  assert(defaultDashboard.companyId === null, 'default dashboard must be a platform template (companyId === null)');
  console.log('  ✓ default dashboard is present as platform template (companyId === null)');

  // 4. Create Company A and Company B Dashboards
  console.log('\n[4] Creating Multi-Tenant Test Dashboards:');
  const compA_Id = 9991;
  const compB_Id = 9992;
  const userA_Id = 8881;
  const userB_Id = 8882;

  const dashA_Id = 'test-dash-corp-a';
  const dashB_Id = 'test-dash-corp-b';

  // Ensure test companies and users exist
  await db.query(
    `INSERT INTO ${T.companies} (id, name, slug)
     VALUES
       (9991, 'Test Corp A', 'test-corp-a'),
       (9992, 'Test Corp B', 'test-corp-b')
     ON CONFLICT (id) DO NOTHING`
  );
  await db.query(
    `INSERT INTO ${T.users} (id, company_id, username, email, role, status)
     VALUES
       (8881, 9991, 'testuser_a', 'user_a@test.com', 'COMPANY_ADMIN', 'active'),
       (8882, 9992, 'testuser_b', 'user_b@test.com', 'COMPANY_ADMIN', 'active'),
       (8883, 9991, 'testuser_user_a', 'user_user_a@test.com', 'USER', 'active')
     ON CONFLICT (id) DO NOTHING`
  );

  // Clean up any old test records
  await registry.deleteDashboard(dashA_Id).catch(() => {});
  await registry.deleteDashboard(dashB_Id).catch(() => {});

  await registry.saveSpec(dashA_Id, { title: 'Corp A Analytics', cards: [{ id: 'card1', title: 'Revenue' }] }, {
    companyId: compA_Id,
    userId: userA_Id,
    title: 'Corp A Analytics',
    description: 'Internal to Corp A',
  });

  await registry.saveSpec(dashB_Id, { title: 'Corp B Analytics', cards: [{ id: 'card1', title: 'Orders' }] }, {
    companyId: compB_Id,
    userId: userB_Id,
    title: 'Corp B Analytics',
    description: 'Internal to Corp B',
  });

  console.log('  ✓ Created dashA for Company A and dashB for Company B');

  // Verify listDashboards(companyId) isolation
  const compAList = await registry.listDashboards(compA_Id);
  const compAIds = compAList.map((d) => d.id);
  assert(compAIds.includes(dashA_Id), 'Company A must see dashA');
  assert(!compAIds.includes(dashB_Id), 'Company A must NOT see dashB');
  assert(compAIds.includes('default'), 'Company A sees global platform dashboard');
  console.log('  ✓ listDashboards(companyA) correctly isolates Company A from Company B');

  // 5. Verify companyDashboardIds isolation
  console.log('\n[5] Testing Access Service Tenant Fence:');
  const compAAllowed = await access.companyDashboardIds(compA_Id);
  assert(compAAllowed.has(dashA_Id), 'companyDashboardIds must include company-owned dashboard');
  assert(!compAAllowed.has(dashB_Id), 'companyDashboardIds must NOT include other company dashboard');
  console.log('  ✓ companyDashboardIds strictly separates company dashboards');

  // 6. Test Card Editing Access for Company Admin & Company User
  console.log('\n[6] Testing Card Editing Capability for Company Admin and Company User:');
  const mockCompanyAdmin = {
    id: userA_Id,
    companyId: compA_Id,
    role: COMPANY_ADMIN,
    isPlatform: false,
    permissions: companyAdminPerms,
  };

  const mockCompanyUser = {
    id: 8883,
    companyId: compA_Id,
    role: USER,
    isPlatform: false,
    permissions: userPerms,
  };

  const adminLevel = await access.getAccessLevel(mockCompanyAdmin, dashA_Id);
  const userLevel = await access.getAccessLevel(mockCompanyUser, dashA_Id);
  assert(adminLevel === 'admin', 'Company Admin must have admin level');
  // A USER's level comes from their grant alone. Holding dashboard.update in
  // the role says they may edit dashboards in general, not this one: with no
  // grant on it they have no access at all (they used to be given "developer").
  assert(userLevel === null, 'Company User with no grant must have no access to the dashboard');
  console.log(`  ✓ Company Admin level: ${adminLevel}`);
  console.log('  ✓ Company User without a grant: no access (edit needs a "developer" grant)');

  // 7. Test Deletion & Cascade
  console.log('\n[7] Testing Dashboard Deletion:');
  await registry.deleteDashboard(dashA_Id);
  const compAListAfterDelete = await registry.listDashboards(compA_Id);
  assert(!compAListAfterDelete.some((d) => d.id === dashA_Id), 'Deleted dashboard must no longer exist');
  console.log('  ✓ dashA was successfully deleted and removed from company listings');

  await registry.deleteDashboard(dashB_Id);
  console.log('  ✓ Cleaned up test dashboards');

  // Clean up test users and companies
  await db.query(`DELETE FROM ${T.users} WHERE id IN (8881, 8882, 8883)`);
  await db.query(`DELETE FROM ${T.companies} WHERE id IN (9991, 9992)`);
  console.log('  ✓ Cleaned up test users and companies');

  console.log('\n=== All Multi-Tenant Dashboard Architecture Tests PASSED! ===');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('\n❌ Test Failed:', err);
  process.exit(1);
});
