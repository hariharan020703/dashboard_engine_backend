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
  const listed = await service.fetchDatasets(adminA, connectionId);
  check('the datasets are listed', listed.length === 3, String(listed.length));
  check('each carries the id a context needs', listed.every((d) => typeof d.id === 'string' && d.id));
  check('row counts are numbers', listed.every((d) => typeof d.rowCount === 'number'));
  check('the owner is flattened to a name', listed[0].owner === 'Ada Lovelace', String(listed[0].owner));

  // 260 across six pages of 50, the last one short - the page loop is the part
  // most likely to either stop early or never stop at all.
  datasetCount = 260;
  seenRequests = [];
  const paged = await service.fetchDatasets(adminA, connectionId);
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
  check('a token with no datasets is not an error', (await service.fetchDatasets(adminA, connectionId)).length === 0);
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
    const got = await service.fetchDatasets(adminA, connectionId);
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
    (await service.fetchDatasets(adminA, connectionId)).length === 0);

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
