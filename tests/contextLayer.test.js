/*
 * The context layer, against a real database and a stand-in Domo.
 *
 * Runs in-process rather than over HTTP, because what needs proving is the
 * part that cannot be reached from outside: that the credential round-trips
 * through encryption, that the company boundary holds in SQL, that a save
 * replaces the selection rather than merging into it, and that Domo's paging
 * and error shapes are read correctly.
 *
 * `global.fetch` is replaced with a scripted Domo. Nothing here reaches the
 * network, and nothing proves the real Domo answers in this shape - only that
 * this code handles the shape it expects and fails legibly when it does not.
 *
 *   DB_NAME=app_e2e node tests/contextLayer.test.js
 *
 * Point it at a throwaway database: it writes companies and users, and drops
 * what it made on the way out.
 */
const assert = require('assert');

process.env.CREDENTIAL_SECRET = process.env.CREDENTIAL_SECRET
  || 'test-only-credential-secret-at-least-32-chars';

const { db } = require('../src/config/database');
const { CT } = require('../src/modules/context-layer/schema');
// The whole schema, not just this module's two tables: they reference
// `companies` and `users`, so the suite has to stand up on an empty database.
const { bootstrapAppMeta } = require('../src/auth/appMetaSchema');
const { seal, open, hint } = require('../src/modules/context-layer/secretBox');
const domo = require('../src/modules/context-layer/providers/domo');
const service = require('../src/modules/context-layer/connectionService');
const store = require('../src/modules/context-layer/contextStore');
const publish = require('../src/modules/context-layer/publishService');

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

/** Runs `work` and returns the error code it threw, or null if it did not. */
async function codeOf(work) {
  try {
    await work();
    return null;
  } catch (err) {
    return err.code || err.name || 'UNKNOWN';
  }
}

/* ------------------------------------------------------------ fake Domo --- */

const GOOD_TOKEN = 'domo-token-that-works';
const GOOD_HOST = 'acme.domo.com';

/** How many datasets the stand-in reports. Set per test. */
let datasetCount = 3;
/** Requests the stand-in saw, so paging and headers can be asserted. */
let seenRequests = [];
/** How the stand-in wraps its rows. Swapped per test. */
let responseShape = (rows) => rows;

function fakeDataset(i) {
  return {
    id: `ds-${String(i).padStart(4, '0')}`,
    name: `Dataset ${String(i).padStart(4, '0')}`,
    rowCount: 1000 + i,
    columnCount: 5,
    owner: { name: 'Ada Lovelace' },
    lastUpdated: 1700000000000 + i,
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFakeDomo() {
  global.fetch = async (url, init = {}) => {
    const target = new URL(url);
    const token = (init.headers || {})['X-DOMO-Developer-Token'];
    seenRequests.push({
      host: target.host, path: target.pathname, query: target.search.replace(/^\?/, ''), token, init,
    });

    if (target.host === 'unreachable.domo.com') {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND unreachable.domo.com'), {
        name: 'TypeError',
      });
    }
    if (token !== GOOD_TOKEN) {
      return json({ status: 401, message: 'Full authentication is required' }, 401);
    }

    if (target.pathname === '/api/content/v2/users/me') {
      return json({ id: 42, displayName: 'Ada Lovelace', emailAddress: 'ada@example.com' });
    }

    // One dataset's own record. Everything the Profile step's header shows.
    const detail = target.pathname.match(/^\/api\/data\/v3\/datasources\/(.+)$/);
    if (detail) {
      return json({
        id: detail[1],
        name: `Dataset ${detail[1]}`,
        description: 'A stand-in dataset',
        rowCount: 4200,
        columnCount: 3,
        sizeInBytes: 2576980377,
        lastTouched: '2026-09-20T10:00:00.000Z',
        owner: { name: 'Ada Lovelace' },
      });
    }

    /*
     * Domo's SQL surface. `metadata` parallel to `columns` is the only place
     * this API exposes per-column types at all, which is why the profile has
     * to run a query rather than read the record above.
     */
    if (target.pathname.startsWith('/api/query/v1/execute/')) {
      return json({
        columns: ['id', 'region', 'revenue'],
        metadata: [{ type: 'LONG' }, { type: 'STRING' }, { type: 'DOUBLE' }],
        rows: [
          [1, 'North', 10.5],
          [2, 'South', 20.5],
          [3, null, 30.5],
          [4, 'North', null],
        ],
      });
    }

    if (target.pathname === '/api/data/v3/datasources') {
      const limit = Number(target.searchParams.get('limit'));
      const offset = Number(target.searchParams.get('offset'));

      /*
       * The real instance enforces this, and answers 400 above it. The
       * stand-in enforces it too, because a fake that accepts anything is how
       * a page size of 100 passed every test here and then failed on the
       * first real connection.
       */
      if (!(limit >= 0 && limit <= 50)) {
        return json(
          { status: 400, message: `'limit' param must be nonnegative and <= 50. actual=${limit}` },
          400
        );
      }

      const page = [];
      for (let i = offset; i < Math.min(offset + limit, datasetCount); i++) {
        page.push(fakeDataset(i));
      }
      // `responseShape` lets a test make Domo answer in a different shape.
      return json(responseShape(page, datasetCount));
    }

    return json({ message: 'no such endpoint' }, 404);
  };
}

/* ------------------------------------------------------------- fixtures --- */

const made = { companies: [], users: [] };

async function makeCompany(name) {
  const { rows } = await db.query(
    `INSERT INTO companies (name, slug, active) VALUES (?, ?, TRUE) RETURNING id`,
    [name, name.toLowerCase().replace(/[^a-z0-9]+/g, '-')]
  );
  made.companies.push(rows[0].id);
  return rows[0].id;
}

async function makeAdmin(companyId, username) {
  const { rows } = await db.query(
    `INSERT INTO users (company_id, username, email, password_hash, role, status)
     VALUES (?, ?, ?, 'x', 'COMPANY_ADMIN', 'active') RETURNING id`,
    [companyId, username, `${username}@example.com`]
  );
  made.users.push(rows[0].id);
  return { id: rows[0].id, username, companyId, isPlatform: false, role: 'COMPANY_ADMIN' };
}

async function cleanup() {
  for (const id of made.companies) {
    // Users, connections and dataset selections all cascade from the company.
    await db.query('DELETE FROM companies WHERE id = ?', [id]);
  }
}

/* ------------------------------------------------------------------ run --- */

(async () => {
  installFakeDomo();
  await bootstrapAppMeta();

  const companyA = await makeCompany('Ctx Alpha');
  const companyB = await makeCompany('Ctx Beta');
  const adminA = await makeAdmin(companyA, 'ctx.alpha.admin');
  const adminB = await makeAdmin(companyB, 'ctx.beta.admin');

  /* ------------------------------------------------------------------ */
  section('Credential encryption');

  const sealed = seal(GOOD_TOKEN);
  check('sealing does not contain the plaintext', !sealed.includes(GOOD_TOKEN), sealed);
  check('sealed value is versioned', sealed.startsWith('v1.'));
  check('opening recovers the original', open(sealed) === GOOD_TOKEN);
  check('sealing twice gives different ciphertext', seal(GOOD_TOKEN) !== sealed);
  check('the hint shows only the last four', hint(GOOD_TOKEN) === '••••orks', hint(GOOD_TOKEN));

  const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
  check('a tampered value fails to open', await codeOf(() => open(tampered)) !== null);

  /* ------------------------------------------------------------------ */
  section('Domo instance addresses');

  check('a bare name becomes the full host', domo.normaliseHost('acme') === 'acme.domo.com');
  check('a URL is reduced to the host', domo.normaliseHost('https://acme.domo.com/datacenter') === 'acme.domo.com');
  check('case and trailing slash are ignored', domo.normaliseHost('ACME.domo.com/') === 'acme.domo.com');
  check('a non-Domo host is refused', await codeOf(() => domo.normaliseHost('evil.example.com')) === 'VALIDATION_ERROR');
  check('an empty address is refused', await codeOf(() => domo.normaliseHost('')) === 'VALIDATION_ERROR');

  /* ------------------------------------------------------------------ */
  section('Connecting');

  datasetCount = 3;
  seenRequests = [];

  const badToken = await codeOf(() =>
    service.createConnection(adminA, companyA, {
      provider: 'domo', name: 'Rejected', host: GOOD_HOST, token: 'wrong-token',
    })
  );
  check('a refused token is CONNECTOR_AUTH_FAILED', badToken === 'CONNECTOR_AUTH_FAILED', badToken);
  check('nothing was saved for a refused token', (await service.listConnections(adminA)).length === 0);

  const unreachable = await codeOf(() =>
    service.createConnection(adminA, companyA, {
      provider: 'domo', name: 'Nowhere', host: 'unreachable.domo.com', token: GOOD_TOKEN,
    })
  );
  check('an unreachable instance is CONNECTOR_UNREACHABLE', unreachable === 'CONNECTOR_UNREACHABLE', unreachable);

  const unknownProvider = await codeOf(() =>
    service.createConnection(adminA, companyA, {
      provider: 'snowflake', name: 'Soon', host: GOOD_HOST, token: GOOD_TOKEN,
    })
  );
  check('an unbuilt provider is refused', unknownProvider === 'VALIDATION_ERROR', unknownProvider);

  const created = await service.createConnection(adminA, companyA, {
    provider: 'domo', name: 'Domo — Sales', host: 'ACME.domo.com/', token: GOOD_TOKEN,
  });
  check('the connection is created', Boolean(created.connection.id));
  check('the host was normalised', created.connection.host === GOOD_HOST, created.connection.host);
  check('the credential was checked before saving', seenRequests.some((r) => r.path === '/api/content/v2/users/me'));
  check('the account behind the token is reported', created.account.accountName === 'Ada Lovelace');
  check('the datasets came back with it', created.datasets.length === 3, String(created.datasets.length));
  check('the token is not in the response', !JSON.stringify(created.connection).includes(GOOD_TOKEN));
  check('the hint is', created.connection.secretHint === '••••orks', created.connection.secretHint);
  check('it starts connected', created.connection.status === 'connected');

  const connectionId = created.connection.id;

  const stored = await db.query(`SELECT secret FROM ${CT.connections} WHERE id = ?`, [connectionId]);
  check('the stored column is not the plaintext', !stored.rows[0].secret.includes(GOOD_TOKEN));
  check('the stored column decrypts to the token', open(stored.rows[0].secret) === GOOD_TOKEN);

  const duplicate = await codeOf(() =>
    service.createConnection(adminA, companyA, {
      provider: 'domo', name: 'Domo — Sales', host: GOOD_HOST, token: GOOD_TOKEN,
    })
  );
  check('the same name twice in one company is refused', duplicate === 'CONFLICT', duplicate);

  /* ------------------------------------------------------------------ */
  section('The company boundary');

  check('the owning company sees it', (await service.listConnections(adminA)).length === 1);
  check('another company does not', (await service.listConnections(adminB)).length === 0);

  const crossRead = await codeOf(() => service.requireConnection(adminB, connectionId));
  check('another company gets 404, not 403', crossRead === 'RESOURCE_NOT_FOUND', crossRead);

  const crossDatasets = await codeOf(() => service.fetchDatasets(adminB, connectionId));
  check('another company cannot list its datasets', crossDatasets === 'RESOURCE_NOT_FOUND', crossDatasets);

  const crossDelete = await codeOf(() => service.deleteConnection(adminB, connectionId));
  check('another company cannot delete it', crossDelete === 'RESOURCE_NOT_FOUND', crossDelete);

  const notAUuid = await codeOf(() => service.requireConnection(adminA, 'not-a-uuid'));
  check('a malformed id is a 404, not a crash', notAUuid === 'RESOURCE_NOT_FOUND', notAUuid);

  /* ------------------------------------------------------------------ */
  section('Listing datasets');

  datasetCount = 3;
  const listing = await service.fetchDatasets(adminA, connectionId);
  const listed = listing.datasets;
  check('the datasets are listed', listed.length === 3, String(listed.length));
  check('each carries the id a context needs', listed.every((d) => typeof d.id === 'string' && d.id));
  check('row counts are numbers', listed.every((d) => typeof d.rowCount === 'number'));
  check('the owner is flattened to a name', listed[0].owner === 'Ada Lovelace', String(listed[0].owner));
  check('a short list is not reported as truncated', listing.truncated === false);

  // 260 across six pages of 50, the last one short - the page loop is the part
  // most likely to either stop early or never stop at all.
  datasetCount = 260;
  seenRequests = [];
  const paged = (await service.fetchDatasets(adminA, connectionId, { limit: 260 })).datasets;
  check('paging reads every dataset', paged.length === 260, String(paged.length));
  const listCalls = seenRequests.filter((r) => r.path === '/api/data/v3/datasources');
  check('it took six pages of 50', listCalls.length === 6, String(listCalls.length));
  check('ids are unique across pages', new Set(paged.map((d) => d.id)).size === 260);

  // The request Domo actually accepts, asserted field by field: every one of
  // these was wrong or missing in the first version that reached a real
  // instance.
  const first = new URL('https://x' + listCalls[0].path + (listCalls[0].search || ''));
  const params = new URLSearchParams(listCalls[0].query || '');
  check('limit never exceeds the cap Domo enforces',
    listCalls.every((c) => Number(new URLSearchParams(c.query).get('limit')) <= 50),
    JSON.stringify(listCalls.map((c) => new URLSearchParams(c.query).get('limit'))));
  check('offset steps by the page size',
    listCalls.map((c) => new URLSearchParams(c.query).get('offset')).join() === '0,50,100,150,200,250',
    listCalls.map((c) => new URLSearchParams(c.query).get('offset')).join());
  check('row and column counts are requested',
    (params.get('part') || '').includes('rowcolcount'), params.get('part'));
  check('hidden datasets are included', params.get('includeHidden') === 'true');
  check('the order is stable across pages', params.get('orderBy') === 'createdAt');
  void first;

  datasetCount = 0;
  check(
    'a token with no datasets is not an error',
    (await service.fetchDatasets(adminA, connectionId)).datasets.length === 0
  );

  /* ---------------------------------------------------------------- */
  section('The listing limit');

  // Listing is the slowest thing the connector does, so it stops early by
  // default. These check that it stops at the right place AND that it says so
  // - a capped list that claims to be the whole warehouse is the failure that
  // matters, because every later step is built from what was selected here.
  datasetCount = 260;

  seenRequests = [];
  const capped = await service.fetchDatasets(adminA, connectionId);
  check('the default stops at 20', capped.datasets.length === 20, String(capped.datasets.length));
  check('the applied limit is reported', capped.limit === 20, String(capped.limit));
  check('it says there is more', capped.truncated === true);
  check(
    'one page was enough',
    seenRequests.filter((r) => r.path === '/api/data/v3/datasources').length === 1
  );

  seenRequests = [];
  const ten = await service.fetchDatasets(adminA, connectionId, { limit: 10 });
  check('an explicit limit is honoured', ten.datasets.length === 10, String(ten.datasets.length));
  check(
    'it asks for one row beyond the limit, to detect more',
    new URLSearchParams(
      seenRequests.find((r) => r.path === '/api/data/v3/datasources').query
    ).get('limit') === '11'
  );
  check('the probe row is not returned', ten.datasets.length === 10);
  check('ten of 260 is truncated', ten.truncated === true);

  // The boundary the probe row exists for: asking for exactly what is there
  // must not report more behind it.
  datasetCount = 10;
  const exact = await service.fetchDatasets(adminA, connectionId, { limit: 10 });
  check('exactly-the-limit is not truncated', exact.truncated === false, String(exact.truncated));
  check('and still returns them all', exact.datasets.length === 10, String(exact.datasets.length));

  datasetCount = 5;
  const under = await service.fetchDatasets(adminA, connectionId, { limit: 50 });
  check('a limit above the total returns the total', under.datasets.length === 5, String(under.datasets.length));
  check('and is not truncated', under.truncated === false);

  /*
   * The boundary that was wrong first time round.
   *
   * When the limit is a multiple of Domo's 50-row page cap, asking for
   * "one more than is left" gets clipped back to 50 - so the probe row is
   * never fetched, and a warehouse with hundreds of datasets reported that
   * the first hundred were all of them. Reading the limit as a ceiling on the
   * whole loop rather than a per-request increment is what fixes it, and
   * these are the cases that tell the two apart.
   */
  datasetCount = 137;
  const overPage = await service.fetchDatasets(adminA, connectionId, { limit: 100 });
  check('a limit on a page boundary still detects more',
    overPage.truncated === true, String(overPage.truncated));
  check('and returns exactly the limit',
    overPage.datasets.length === 100, String(overPage.datasets.length));

  datasetCount = 100;
  const onPage = await service.fetchDatasets(adminA, connectionId, { limit: 100 });
  check('exactly a page-boundary total is not truncated',
    onPage.truncated === false, String(onPage.truncated));

  datasetCount = 51;
  const justOver = await service.fetchDatasets(adminA, connectionId, { limit: 50 });
  check('one beyond a single page is truncated',
    justOver.truncated === true, String(justOver.truncated));

  datasetCount = 3;

  /* ------------------------------------------------------------------ */
  section('Whatever shape Domo answers in');

  datasetCount = 3;
  for (const [label, wrap] of [
    ['a bare array', (rows) => rows],
    ['{ dataSources }', (rows) => ({ dataSources: rows })],
    ['{ searchObjects }', (rows) => ({ searchObjects: rows })],
    ['{ results }', (rows) => ({ results: rows })],
    ['{ searchResultsMap: { DATASET } }', (rows) => ({ searchResultsMap: { DATASET: rows } })],
  ]) {
    responseShape = wrap;
    const got = (await service.fetchDatasets(adminA, connectionId)).datasets;
    check(`${label} is read correctly`, got.length === 3, String(got.length));
  }

  /*
   * The regression that started all this: an unrecognised response used to be
   * read as an empty list, so a wrong endpoint looked exactly like a working
   * connection to an account with no datasets - "connected", zero rows, no
   * error anywhere.
   */
  responseShape = () => ({ totalResultCount: 42, somethingElse: {} });
  const unknownShape = await codeOf(() => service.fetchDatasets(adminA, connectionId));
  check('an unrecognised shape is an error, not an empty list',
    unknownShape === 'CONNECTOR_UNREACHABLE', unknownShape);

  responseShape = () => ({ dataSources: [] });
  check('a genuinely empty list is still not an error',
    (await service.fetchDatasets(adminA, connectionId)).datasets.length === 0);

  responseShape = (rows) => rows;

  /* ------------------------------------------------------------------ */
  section('Choosing datasets');

  let connection = await service.requireConnection(adminA, connectionId);
  check('nothing is selected to begin with', connection.selectedDatasets.length === 0);

  connection = await service.replaceSelection(adminA, connectionId, [
    { id: 'ds-0000', name: 'Dataset 0000', rowCount: 1000, columnCount: 5 },
    { id: 'ds-0002', name: 'Dataset 0002', rowCount: 1002, columnCount: 5 },
  ]);
  check('two datasets are selected', connection.selectedDatasets.length === 2);
  check('the dataset id is what is stored', connection.selectedDatasets.map((d) => d.id).join() === 'ds-0000,ds-0002');
  check('the name is kept alongside it', connection.selectedDatasets[0].name === 'Dataset 0000');

  connection = await service.replaceSelection(adminA, connectionId, [{ id: 'ds-0001' }]);
  check('saving replaces rather than merges', connection.selectedDatasets.length === 1, String(connection.selectedDatasets.length));
  check('the surviving row is the new one', connection.selectedDatasets[0].id === 'ds-0001');

  connection = await service.replaceSelection(adminA, connectionId, [
    { id: 'ds-0001' }, { id: 'ds-0001' }, { id: '  ' },
  ]);
  check('duplicates and blanks are dropped', connection.selectedDatasets.length === 1);

  connection = await service.replaceSelection(adminA, connectionId, []);
  check('the selection can be cleared', connection.selectedDatasets.length === 0);

  const notAList = await codeOf(() => service.replaceSelection(adminA, connectionId, 'ds-0001'));
  check('a non-list is refused', notAList === 'VALIDATION_ERROR', notAList);

  await service.replaceSelection(adminA, connectionId, [{ id: 'ds-0000' }, { id: 'ds-0001' }]);
  const listRow = (await service.listConnections(adminA))[0];
  check('the list read carries the selected count', listRow.selectedDatasetCount === 2, String(listRow.selectedDatasetCount));

  /* ------------------------------------------------------------------ */
  section('Profiling');

  /*
   * Profile is SOURCE data, not AI output - that distinction is the reason it
   * is a separate step from Understand, so these check that it reads the
   * warehouse and reports what it found, including what it could not find.
   */
  // Re-selected WITH counts: the tree reports what was captured at selection
  // time, so a selection that carried none is a tree of nulls.
  await service.replaceSelection(adminA, connectionId, [
    { id: 'ds-0000', name: 'Dataset 0000', rowCount: 1000, columnCount: 5 },
    { id: 'ds-0001', name: 'Dataset 0001', rowCount: 1001, columnCount: 5 },
  ]);

  seenRequests = [];
  const overview = await service.profileOverview(adminA, connectionId);
  check('the tree is the stored selection', overview.datasets.length === 2, String(overview.datasets.length));
  check('a Domo dataset is one table', overview.datasets[0].tables.length === 1);
  check('the stored counts come through', overview.datasets[0].tables[0].rowCount === 1000,
    String(overview.datasets[0].tables[0].rowCount));
  check('the tree costs no warehouse call', seenRequests.length === 0, String(seenRequests.length));

  await service.replaceSelection(adminA, connectionId, [{ id: 'ds-0000' }]);
  const noCounts = await service.profileOverview(adminA, connectionId);
  check('a selection with no counts reports null, not zero',
    noCounts.datasets[0].tables[0].rowCount === null,
    String(noCounts.datasets[0].tables[0].rowCount));
  await service.replaceSelection(adminA, connectionId, [
    { id: 'ds-0000', name: 'Dataset 0000', rowCount: 1000, columnCount: 5 },
    { id: 'ds-0001', name: 'Dataset 0001', rowCount: 1001, columnCount: 5 },
  ]);

  seenRequests = [];
  const profile = await service.tableProfile(adminA, connectionId, 'ds-0000');
  check('the table name comes from the source', profile.name === 'Dataset ds-0000', profile.name);
  check('the row count comes from the source', profile.rowCount === 4200, String(profile.rowCount));
  check('storage is the byte count the source reported',
    profile.sizeBytes === 2576980377, String(profile.sizeBytes));
  check('the columns are the ones the source reports',
    profile.columns.map((c) => c.name).join() === 'id,region,revenue',
    profile.columns.map((c) => c.name).join());
  check('column types come through', profile.columns[1].dataType === 'STRING', profile.columns[1].dataType);

  // 1 of 4 region values is null; 3 of 4 revenue values are present.
  check('null rates are computed from the sample',
    profile.columns[1].nullPercent === 25, String(profile.columns[1].nullPercent));
  check('distinct counts too',
    profile.columns[1].uniqueCount === 2, String(profile.columns[1].uniqueCount));
  check('min/max only for numeric columns',
    profile.columns[2].min === 10.5 && profile.columns[2].max === 30.5,
    `${profile.columns[2].min}/${profile.columns[2].max}`);
  check('a text column gets no min/max',
    profile.columns[1].min === null && profile.columns[1].max === null);
  check('the stats say what they were computed over',
    profile.statsSampleSize === 4, String(profile.statsSampleSize));
  check('sample rows come back', profile.sample.rows.length === 4, String(profile.sample.rows.length));

  // Nothing on this API surface reports these. Absent, not invented.
  check('semantic types are absent rather than guessed', profile.columns[0].semanticType === null);
  check('quality is absent rather than scored', profile.qualityScore === null);

  check('it took one detail call and one query',
    seenRequests.length === 2, String(seenRequests.length));

  const unselected = await codeOf(() => service.tableProfile(adminA, connectionId, 'ds-0099'));
  check('a table outside the selection is a 404', unselected === 'RESOURCE_NOT_FOUND', unselected);

  const crossProfile = await codeOf(() => service.tableProfile(adminB, connectionId, 'ds-0000'));
  check('another company cannot profile it', crossProfile === 'RESOURCE_NOT_FOUND', crossProfile);

  /* ------------------------------------------------------------------ */
  section('A credential that stops working');

  const verified = await service.verifyConnection(adminA, connectionId);
  check('verify reports the account', verified.account.accountEmail === 'ada@example.com');
  check('verify leaves it connected', verified.connection.status === 'connected');

  // Domo now refuses the token this connection holds.
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    const target = new URL(url);
    if (target.host === GOOD_HOST) return json({ message: 'Token revoked' }, 401);
    return realFetch(url, init);
  };

  const revoked = await codeOf(() => service.fetchDatasets(adminA, connectionId));
  check('a revoked token is CONNECTOR_AUTH_FAILED', revoked === 'CONNECTOR_AUTH_FAILED', revoked);

  const afterRevoke = await service.requireConnection(adminA, connectionId);
  check('the connection is marked invalid', afterRevoke.status === 'invalid', afterRevoke.status);
  check('and says why', Boolean(afterRevoke.lastError));
  check('the selection survives a revoked token', afterRevoke.selectedDatasets.length === 2);

  // An instance that is merely unreachable must NOT be reported as a bad token.
  global.fetch = async (url) => {
    void url;
    throw Object.assign(new Error('socket hang up'), { name: 'TypeError' });
  };
  const blip = await codeOf(() => service.verifyConnection(adminA, connectionId));
  check('an outage is CONNECTOR_UNREACHABLE', blip === 'CONNECTOR_UNREACHABLE', blip);

  global.fetch = realFetch;
  installFakeDomo();

  /* ------------------------------------------------------------------ */
  section('Model, review and publish');

  /*
   * These read `context_objects`, which the Context Layer service owns and
   * this suite's database does not have. Created here rather than skipped,
   * because the SQL against it - the latest-session subquery, the JSONB
   * merge, the two-table transaction - is exactly the part worth proving.
   */
  await db.raw(`
    CREATE TABLE IF NOT EXISTS context_objects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL,
      bundle_id UUID NULL,
      object_type TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      verified BOOLEAN NOT NULL DEFAULT false,
      confidence NUMERIC,
      payload JSONB NOT NULL,
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ,
      session_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, qualified_name)
    )`);

  const fixture = async (ws, session, type, name, payload, extra = {}) => {
    const { rows } = await db.query(
      `INSERT INTO context_objects
         (workspace_id, object_type, qualified_name, source_type, verified,
          confidence, payload, session_id, created_at)
       VALUES (?::uuid, ?, ?, ?, ?, ?, ?::jsonb, ?, now() + (? * interval '1 second'))
       RETURNING id`,
      [ws, type, name, extra.source || 'db_inferred', extra.verified ?? false,
       extra.confidence ?? null, JSON.stringify(payload), session, extra.order ?? 0]
    );
    return rows[0].id;
  };

  const ws = connectionId;
  const RUN = 'run-current';

  // An older run, to prove only the latest one is read.
  await fixture(ws, 'run-old', 'table', 'stale_table', { description: 'from a previous run' }, { order: -100 });

  await fixture(ws, RUN, 'table', 'orders', { description: 'Order header rows' }, { order: 1 });
  await fixture(ws, RUN, 'table', 'customers', { description: 'Customer master' }, { order: 2 });
  const colId = await fixture(ws, RUN, 'column_stats', 'orders.customer_id',
    { data_type: 'STRING', null_rate: '0.0%', description: 'FK to customers', note: 'candidate primary key' },
    { order: 3 });
  await fixture(ws, RUN, 'column_stats', 'orders.total',
    { data_type: 'DOUBLE', null_rate: '0.0%', description: 'Order total' }, { order: 4 });
  await fixture(ws, RUN, 'join', 'orders__customers', {
    tables: ['orders', 'customers'],
    join_keys: [{ left: 'customer_id', right: 'id' }],
    cardinality: 'many:1',
    basis: 'FK enforced',
  }, { confidence: 0.97, order: 5 });
  // A join naming a table with no `table` row - the node must still appear.
  await fixture(ws, RUN, 'join', 'orders__regions', {
    tables: ['orders', 'regions'],
    join_keys: [{ left: 'region_code', right: 'code' }],
    cardinality: 'many:1',
    basis: 'name match',
  }, { confidence: 0.6, order: 6 });

  const graph = await store.modelGraph(ws);
  check('only the latest run is read',
    !graph.nodes.some((n) => n.id === 'stale_table'),
    graph.nodes.map((n) => n.id).join(','));
  check('a node per table', graph.nodes.length === 3, String(graph.nodes.length));
  check('a join to an unrecorded table still makes a node',
    graph.nodes.some((n) => n.id === 'regions'));
  check('columns hang off their table',
    graph.nodes.find((n) => n.id === 'orders').columns.length === 2,
    String(graph.nodes.find((n) => n.id === 'orders').columns.length));
  check('a candidate key is read from the note, not guessed',
    graph.nodes.find((n) => n.id === 'orders').columns.find((c) => c.name === 'customer_id').isPrimaryKey);
  check('an edge per join', graph.edges.length === 2, String(graph.edges.length));
  check('the join condition is built from join_keys',
    graph.edges[0].joinCondition === 'orders.customer_id = customers.id',
    graph.edges[0].joinCondition);
  check('confidence comes through', graph.edges[0].confidence === 0.97, String(graph.edges[0].confidence));
  check('an unverified join is suggested', graph.edges[0].status === 'suggested', graph.edges[0].status);

  const queue = await store.reviewQueue(ws);
  check('every object is reviewable', queue.total === 6, String(queue.total));
  check('counts are per type', queue.counts.column_stats === 2 && queue.counts.join === 2,
    JSON.stringify(queue.counts));
  check('everything starts pending',
    queue.items.every((i) => i.status === 'pending'));
  check('the note surfaces as downstream impact',
    queue.items.find((i) => i.id === colId).downstreamImpact === 'candidate primary key');

  await store.decideReviewItem(adminA, ws, colId, 'approve');
  const afterApprove = await store.reviewQueue(ws);
  check('approving sets our status',
    afterApprove.items.find((i) => i.id === colId).status === 'approved');
  const { rows: verifiedRow } = await db.query(
    'SELECT verified, reviewed_by FROM context_objects WHERE id = ?::uuid', [colId]);
  check('and mirrors verified into context_objects, which the analyst agent reads',
    verifiedRow[0].verified === true, String(verifiedRow[0].verified));
  check('recording who did it', verifiedRow[0].reviewed_by === adminA.username);

  await store.decideReviewItem(adminA, ws, colId, 'skip');
  const { rows: afterSkip } = await db.query(
    'SELECT verified FROM context_objects WHERE id = ?::uuid', [colId]);
  check('skip records a status but does not touch verified',
    afterSkip[0].verified === true, String(afterSkip[0].verified));
  check('skip is a status a boolean cannot hold',
    (await store.reviewQueue(ws)).items.find((i) => i.id === colId).status === 'skipped');

  await store.updateReviewItem(adminA, ws, colId, { description: 'Edited by a human' });
  const { rows: merged } = await db.query(
    'SELECT payload FROM context_objects WHERE id = ?::uuid', [colId]);
  check('an edit changes the key it names',
    merged[0].payload.description === 'Edited by a human', merged[0].payload.description);
  check('and merges rather than replacing - the rest of the payload survives',
    merged[0].payload.data_type === 'STRING' && merged[0].payload.null_rate === '0.0%',
    JSON.stringify(merged[0].payload));

  const bulk = await store.bulkDecide(adminA, ws, {
    decision: 'approve', filter: { minConfidence: 0.9 },
  });
  check('a bulk decision acts on what matches, not on what is on screen',
    bulk.affected === 1, String(bulk.affected));
  check('a row with no confidence does not pass a confidence bar',
    (await store.reviewQueue(ws)).items.find((i) => i.type === 'table').status === 'pending');

  const crossReview = await codeOf(() => service.requireConnection(adminB, connectionId));
  check('another company cannot reach this connection at all',
    crossReview === 'RESOURCE_NOT_FOUND', crossReview);

  // The column above is currently skipped. Approving it again proves a skip is
  // "not now" rather than a terminal state, and gives the publish below two
  // approved facts of different types to count.
  await store.decideReviewItem(adminA, ws, colId, 'approve');
  check('a skipped item can be approved later',
    (await store.reviewQueue(ws)).items.find((i) => i.id === colId).status === 'approved');

  /* ------------------------------------------------------------------ */
  const connectionRow = await service.requireConnection(adminA, connectionId);

  let summary = await publish.publishSummary(adminA, connectionRow);
  check('the summary counts approved facts only',
    summary.stats.find((s) => s.id === 'columns').value === 1,
    JSON.stringify(summary.stats.find((s) => s.id === 'columns')));
  check('pending items are a warning, not a blocker',
    summary.blockers.some((b) => b.severity === 'warning' && b.step === 'review'));
  check('it is publishable once something is approved', summary.ready === true);
  check('the name defaults to the connection, as a starting point',
    summary.suggestedName === connectionRow.name, summary.suggestedName);

  const noName = await codeOf(() => publish.publishContext(adminA, connectionRow, { name: '' }));
  check('publishing requires a name', noName === 'VALIDATION_ERROR', noName);

  const v1 = await publish.publishContext(adminA, connectionRow, { name: 'Revenue' });
  check('publishing returns a version', v1.version === 'v1', v1.version);
  check('and counts what it stored', v1.objectCount === 2, String(v1.objectCount));

  const { rows: storedRow } = await db.query(
    `SELECT name, version, object_count, snapshot, company_id
       FROM ${CT.publications} WHERE id = ?::uuid`, [v1.id]);
  check('the row is keyed by the name the user gave',
    storedRow[0].name === 'Revenue', storedRow[0].name);
  check('and scoped to their company', storedRow[0].company_id === companyA);
  check('the snapshot holds the facts themselves, not just ids',
    Array.isArray(storedRow[0].snapshot) && storedRow[0].snapshot[0].payload !== undefined,
    JSON.stringify(storedRow[0].snapshot).slice(0, 80));

  const v2 = await publish.publishContext(adminA, connectionRow, { name: 'Revenue' });
  check('republishing the same name makes the next version', v2.version === 'v2', v2.version);
  const other = await publish.publishContext(adminA, connectionRow, { name: 'Site safety' });
  check('a different name starts again at v1', other.version === 'v1', other.version);

  const history = await publish.listPublications(connectionId);
  check('every version is listed, newest first', history.length === 3, String(history.length));

  /* ------------------------------------------------------------------ */
  section('Deleting');

  await service.deleteConnection(adminA, connectionId);
  check('the connection is gone', (await service.listConnections(adminA)).length === 0);

  const orphans = await db.query(
    `SELECT COUNT(*)::int AS n FROM ${CT.datasets} WHERE connection_id = ?`,
    [connectionId]
  );
  check('its dataset selection went with it', orphans.rows[0].n === 0, String(orphans.rows[0].n));

  /* ------------------------------------------------------------------ */
  await cleanup();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  await db.end?.();
  process.exit(failed ? 1 : 0);
})().catch(async (err) => {
  console.error('\nHARNESS ERROR:', err);
  try { await cleanup(); } catch { /* the run is already lost */ }
  process.exit(1);
});

// Referenced so a future edit that stops using it is a lint error rather than
// a silently dead import.
void assert;
