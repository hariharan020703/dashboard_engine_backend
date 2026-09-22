const { fail } = require('../../../api/response');

/**
 * Domo, reached with a developer access token.
 *
 * Domo has two credential models and they are not interchangeable:
 *
 *   OAuth client  - a client id and secret, used against api.domo.com. The
 *                   published, versioned public API.
 *   Access token  - issued in Admin -> Authentication -> Access tokens, sent as
 *                   `X-DOMO-Developer-Token` against the customer's OWN
 *                   instance. This is what the screen asks for.
 *
 * The second is why the connection form asks for the instance as well as the
 * token. A token carries no address: it is issued by one Domo instance and
 * means nothing at another, so there is nothing to infer it from and asking is
 * the only correct option.
 *
 * ---------------------------------------------------------------------------
 * The two endpoints below are the instance API that Domo's own web client
 * uses. They are not part of the versioned public API and Domo can change them
 * without notice. They are kept together, named, and every failure reports the
 * status and Domo's own message, so if a shape changes the error says where -
 * and the fix is this file alone.
 * ---------------------------------------------------------------------------
 */

const WHOAMI_PATH = '/api/content/v2/users/me';

/*
 * The dataset list.
 *
 * A GET that returns a plain JSON array of datasources, rather than the UI's
 * POST search endpoint: the search endpoint takes a body whose shape is tied
 * to the UI's own filter model, and getting that body subtly wrong returns a
 * successful, empty result - which is indistinguishable from an account that
 * genuinely has no datasets. This one has no body to get wrong.
 */
const DATASET_LIST_PATH = '/api/data/v3/datasources';

/*
 * Domo enforces a hard cap of 50 and answers 400 above it:
 *
 *   'limit' param must be nonnegative and <= 50. actual=100
 *
 * Not a guess - that is the instance's own message, which is why the page size
 * is a named constant rather than a number inlined into the query.
 */
const PAGE_SIZE = 50;

/** Stops a misconfigured instance from being walked indefinitely: 5000 datasets. */
const MAX_PAGES = 100;
const REQUEST_TIMEOUT_MS = 20000;

/*
 * Which blocks of each datasource Domo should include.
 *
 * `part` is not optional decoration: without `rowcolcount` the response
 * carries no rowCount or columnCount, and the picker loses the one number
 * that tells a real dataset from an empty shell. The rest is what Domo's own
 * data centre asks for, kept as a list so a field that turns out to be missing
 * has an obvious place to be added.
 */
const DATASET_PARTS = [
  'core', 'permission', 'status', 'pdp', 'rowcolcount', 'certification',
  'sharecount', 'alertcount', 'dataprovider', 'features', 'impactcounts',
  'functions', 'cryo', 'warnings', 'pharos',
].join(',');

/*
 * Built by hand rather than with URLSearchParams: the commas in `part` are
 * legal unencoded, and percent-encoding them is a needless difference from the
 * request Domo's own client sends.
 *
 * `orderBy=createdAt` gives paging a stable order. Sorting by name would be
 * friendlier, but the display order is decided below after every page is in -
 * what matters here is that the sequence does not shift between requests and
 * silently skip a row.
 */
function datasetPageQuery(page) {
  return (
    `?limit=${PAGE_SIZE}` +
    `&offset=${page * PAGE_SIZE}` +
    `&part=${DATASET_PARTS}` +
    '&includeHidden=true' +
    '&orderBy=createdAt'
  );
}

/**
 * Normalises whatever was typed into a bare hostname.
 *
 * People paste `https://acme.domo.com/datacenter`, type `acme`, or copy the
 * host with a trailing slash. All three mean the same instance, and rejecting
 * two of them teaches nothing.
 */
function normaliseHost(input) {
  let value = String(input || '').trim().toLowerCase();
  if (!value) {
    throw fail('VALIDATION_ERROR', 'The Domo instance is required, for example acme.domo.com');
  }

  value = value.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  // A bare workspace name is the common shorthand for <name>.domo.com.
  if (!value.includes('.')) value = `${value}.domo.com`;

  if (!/^[a-z0-9][a-z0-9.-]{1,188}$/.test(value) || !value.endsWith('.domo.com')) {
    throw fail(
      'VALIDATION_ERROR',
      `"${input}" is not a Domo instance address. It looks like acme.domo.com.`
    );
  }
  return value;
}

/**
 * One request to a Domo instance.
 *
 * Every failure is classified into exactly one of three outcomes, because the
 * person looking at the screen can act on each differently: the token is wrong
 * and must be replaced, the instance is unreachable and they should retry, or
 * Domo answered with something this code did not expect and the message needs
 * to carry enough to diagnose it.
 */
async function callDomo(host, token, path, { method = 'GET', body } = {}) {
  const url = `https://${host}${path}`;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'X-DOMO-Developer-Token': token,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // DNS failure, refused connection, TLS problem, or the timeout above. None
    // of these say anything about whether the token is valid.
    const reason = err.name === 'TimeoutError'
      ? `it did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds`
      : err.message;
    throw fail('CONNECTOR_UNREACHABLE', `Could not reach ${host}: ${reason}`);
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { /* Domo sent something that is not JSON */ }
  }

  if (response.status === 401 || response.status === 403) {
    throw fail(
      'CONNECTOR_AUTH_FAILED',
      `${host} rejected that access token. Check it has not been revoked or expired, ` +
      'and that it was issued by this instance.'
    );
  }

  if (!response.ok) {
    const detail = (payload && (payload.message || payload.error)) || text.slice(0, 200) || 'no detail';
    throw fail(
      'CONNECTOR_UNREACHABLE',
      `${host} answered ${response.status} for ${path}: ${detail}`
    );
  }

  return payload;
}

/**
 * Confirms the token works, and reports whose it is.
 *
 * Checked against the identity endpoint rather than by listing datasets: an
 * account with a valid token and no datasets is a working connection, and
 * proving the credential should not depend on there being data behind it.
 */
async function verify({ host, token }) {
  const me = await callDomo(host, token, WHOAMI_PATH);
  return {
    accountId: me && (me.id ?? me.userId ?? null),
    accountName: (me && (me.displayName || me.name || me.emailAddress)) || null,
    accountEmail: (me && (me.emailAddress || me.email)) || null,
  };
}

/** One row of the dataset picker, from whatever shape Domo returned. */
function shapeDataset(row) {
  if (!row || typeof row !== 'object') return null;
  const id = row.id ?? row.datasourceId ?? row.dataSourceId;
  if (!id) return null;

  const owner = row.owner && typeof row.owner === 'object'
    ? (row.owner.name || row.owner.displayName || null)
    : (row.ownerName || null);

  return {
    id: String(id),
    name: row.name || row.displayName || String(id),
    description: row.description || null,
    rowCount: Number.isFinite(Number(row.rowCount)) ? Number(row.rowCount) : null,
    columnCount: Number.isFinite(Number(row.columnCount)) ? Number(row.columnCount) : null,
    owner,
    lastUpdated: row.lastUpdated ?? row.lastTouched ?? null,
  };
}

/**
 * Finds the array of datasources in whatever Domo sent back.
 *
 * Returns null when there is no recognisable array, which the caller turns
 * into an error. It deliberately does NOT fall back to an empty list: "I do
 * not understand this response" and "this account has no datasets" look
 * identical on screen, and conflating them is how a wrong endpoint reads as a
 * working connection to an empty warehouse.
 */
function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;

  for (const key of ['dataSources', 'datasources', 'searchObjects', 'results', 'items']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  // The newer search response nests results by entity type.
  const byEntity = payload.searchResultsMap;
  if (byEntity && typeof byEntity === 'object') {
    for (const value of Object.values(byEntity)) {
      if (Array.isArray(value)) return value;
    }
  }
  return null;
}

/**
 * Every dataset the token can see, paged until Domo stops returning rows.
 *
 * The loop stops on three conditions rather than one - a short page, an empty
 * page, or the page cap - because an endpoint that ignores `offset` would
 * otherwise return page one forever.
 */
async function listDatasets({ host, token }) {
  const datasets = [];
  const seen = new Set();

  for (let page = 0; page < MAX_PAGES; page++) {
    const payload = await callDomo(host, token, DATASET_LIST_PATH + datasetPageQuery(page));

    const rows = extractRows(payload);
    if (rows === null) {
      /*
       * Logged as well as thrown. The message has to stay short enough to read
       * on screen, but fixing a changed response shape needs to see the shape -
       * and this is a list of datasets, so there is no credential in it.
       */
      const shape = payload && typeof payload === 'object'
        ? Object.keys(payload).join(', ') || '(no keys)'
        : typeof payload;
      console.error(
        `[domo] unrecognised response from ${DATASET_LIST_PATH} - keys: ${shape}
` +
        `[domo] sample: ${JSON.stringify(payload).slice(0, 600)}`
      );
      throw fail(
        'CONNECTOR_UNREACHABLE',
        `${host} answered ${DATASET_LIST_PATH} with something this connector does not ` +
        `recognise (fields: ${shape}). The instance API may have changed - the server log ` +
        'has the response, and providers/domo.js is the only file that needs to change.'
      );
    }

    let added = 0;
    for (const row of rows) {
      const dataset = shapeDataset(row);
      // An endpoint that ignores the offset repeats itself; deduplicating by id
      // means that shows up as "no new rows" and ends the loop.
      if (!dataset || seen.has(dataset.id)) continue;
      seen.add(dataset.id);
      datasets.push(dataset);
      added++;
    }

    if (rows.length < PAGE_SIZE || added === 0) break;
  }

  // String(): a name that arrives as a number has no localeCompare, and a
  // TypeError thrown from inside sort() is a 500 with a baffling stack.
  datasets.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return datasets;
}

module.exports = { normaliseHost, verify, listDatasets };
