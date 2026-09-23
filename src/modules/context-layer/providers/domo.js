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

/** One dataset's own record: name, description, counts, owner, timestamps. */
const datasetDetailPath = (datasetId) =>
  `/api/data/v3/datasources/${encodeURIComponent(datasetId)}`;

/**
 * Domo's SQL surface over one dataset.
 *
 * This is the only endpoint on this API that reports per-column TYPES - the
 * dataset-detail record above does not carry them at all. A one-row query is
 * therefore the cheapest way to learn a dataset's shape, and a larger one
 * gives the sample rows and the column statistics in the same round trip.
 */
const queryExecutePath = (datasetId) =>
  `/api/query/v1/execute/${encodeURIComponent(datasetId)}`;

/**
 * How many rows the profile samples.
 *
 * Statistics computed from this are ESTIMATES on anything larger, and every
 * one of them is reported alongside the sample size that produced it. The
 * alternative - scanning the dataset to get exact null rates - is a full table
 * read per column on data this application does not own, for a number nobody
 * needs to four decimal places.
 */
const PROFILE_SAMPLE_ROWS = 500;

/** How many of those rows are handed back for the "Sample records" tab. */
const SAMPLE_ROWS_SHOWN = 20;

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

/**
 * How many datasets a listing returns when the caller does not say.
 *
 * Listing is the slowest thing this connector does — an instance with a few
 * thousand datasets is dozens of round trips before the picker can draw
 * anything, and nobody chooses from a list that long by scrolling it. So the
 * default is a first page's worth, and a caller that genuinely wants more asks
 * for more.
 *
 * The ceiling is not a performance guess: `MAX_PAGES * PAGE_SIZE` is the most
 * the paging loop can return anyway, and naming it here means a caller asking
 * for more gets a number the loop can actually honour rather than one it will
 * silently fall short of.
 */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = MAX_PAGES * PAGE_SIZE;

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
 * silently skip a row. That matters more, not less, now that a listing can
 * stop early: "the first 20" is only a meaningful answer if two calls agree on
 * which 20 those are.
 *
 * `offset` is a row cursor rather than a page number, because the page size
 * varies once a limit is in play - the last page asks only for what is left.
 */
function datasetPageQuery(offset, pageSize) {
  return (
    `?limit=${pageSize}` +
    `&offset=${offset}` +
    `&part=${DATASET_PARTS}` +
    '&includeHidden=true' +
    '&orderBy=createdAt'
  );
}

/**
 * Clamps a requested limit into something the paging loop can honour.
 *
 * Anything unparseable falls back to the default rather than throwing: this is
 * called with a value that has already been validated at the route, and a
 * second, differently-worded rejection here would only be reachable by a bug.
 */
function resolveLimit(limit) {
  const value = Math.floor(Number(limit));
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
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
 * The first `limit` datasets the token can see, paged until it has them.
 *
 * The loop stops on four conditions rather than one - the limit, a short page,
 * an empty page, or the page cap. The last two are not redundant: an endpoint
 * that ignored `offset` would otherwise return page one forever, and
 * deduplicating by id turns that into "no new rows" so it ends instead.
 *
 * Each request asks for one row MORE than is still needed. That extra row is
 * never returned to the caller; it exists so `truncated` can be stated as a
 * fact rather than guessed at. Without it, an account holding exactly 20
 * datasets and a limit of 20 are indistinguishable from an account holding
 * hundreds - both fill the page - and the screen would have to say "showing the
 * first 20" to somebody who is in fact looking at all of them.
 */
async function listDatasets({ host, token, limit } = {}) {
  const target = resolveLimit(limit);
  /*
   * Collect one MORE than was asked for, then hand back only `target`.
   *
   * The extra row is the probe: holding it is what lets `truncated` be a fact
   * rather than a guess. Expressing it as a ceiling on the whole loop, rather
   * than as "+1 on each request", matters when the limit is a multiple of the
   * page size - `remaining + 1` would be clipped by Domo's own cap of 50 and
   * the probe would never be fetched, so 137 datasets read at a limit of 100
   * reported that there were no more.
   */
  const ceiling = target + 1;
  const datasets = [];
  const seen = new Set();
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const remaining = ceiling - datasets.length;
    if (remaining <= 0) break;

    const pageSize = Math.min(PAGE_SIZE, remaining);
    const payload = await callDomo(host, token, DATASET_LIST_PATH + datasetPageQuery(offset, pageSize));

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

    // Domo's own cursor counts every row it sent, including any this code
    // discarded - advancing by `added` instead would re-request them forever.
    offset += rows.length;

    let added = 0;
    for (const row of rows) {
      const dataset = shapeDataset(row);
      // An endpoint that ignores the offset repeats itself; deduplicating by id
      // means that shows up as "no new rows" and ends the loop.
      if (!dataset || seen.has(dataset.id)) continue;
      if (datasets.length >= ceiling) break;

      seen.add(dataset.id);
      datasets.push(dataset);
      added++;
    }

    // A page shorter than what was asked for is Domo saying there is no more.
    if (rows.length < pageSize || added === 0) break;
  }

  // Holding one beyond the limit is how "there is more" was established; it is
  // not part of the answer, so it is dropped before anything sees it.
  const truncated = datasets.length > target;
  if (truncated) datasets.length = target;

  // String(): a name that arrives as a number has no localeCompare, and a
  // TypeError thrown from inside sort() is a 500 with a baffling stack.
  datasets.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { datasets, truncated, limit: target };
}

/* ------------------------------------------------------------- profiling --- */

/**
 * Classifies a Domo column type into what the UI needs to know about it.
 *
 * Domo reports LONG, DOUBLE, DECIMAL, STRING, DATE, DATETIME. Only the
 * numeric/temporal split matters here - min/max are computed for the first
 * group and skipped for the rest, because the minimum of a set of strings is
 * a fact nobody asked for.
 */
function isNumericType(domoType) {
  return ['LONG', 'DOUBLE', 'DECIMAL', 'INTEGER', 'FLOAT', 'NUMBER'].includes(
    String(domoType || '').toUpperCase()
  );
}

/**
 * Per-column statistics from a row sample.
 *
 * Computed here, in the backend, over rows Domo returned once. The frontend
 * never sees the sample beyond the handful of rows it displays, and nothing
 * downloads a dataset to measure it.
 *
 * `nullPercent` and `uniqueCount` are honest about their basis: they describe
 * the sample, and the sample size travels with them so the screen can say so.
 */
function profileColumns(names, types, rows) {
  const sampleSize = rows.length;

  return names.map((name, index) => {
    const type = types[index] ?? null;
    const values = rows.map((row) => (Array.isArray(row) ? row[index] : undefined));
    const present = values.filter((v) => v !== null && v !== undefined);
    const distinct = new Set(present.map((v) => String(v)));

    let min = null;
    let max = null;
    if (isNumericType(type)) {
      const numbers = present.map(Number).filter((n) => Number.isFinite(n));
      if (numbers.length) {
        min = Math.min(...numbers);
        max = Math.max(...numbers);
      }
    }

    return {
      name,
      dataType: type ?? 'UNKNOWN',
      // Domo's query surface does not report nullability as a constraint; what
      // it reports is whether nulls were seen, which is a different claim.
      nullable: null,
      nullPercent: sampleSize ? ((sampleSize - present.length) / sampleSize) * 100 : null,
      uniqueCount: sampleSize ? distinct.size : null,
      // Neither semantic classification nor keys are exposed by this API.
      // Reported as absent rather than guessed at from a column's name.
      semanticType: null,
      isPrimaryKey: false,
      isForeignKey: false,
      min,
      max,
      distribution: null,
    };
  });
}

/**
 * Everything the Profile step shows about one dataset.
 *
 * Two requests, and the second earns its cost three times over: the query
 * surface is the ONLY place this API exposes per-column types, and the same
 * response also carries the sample rows and the values the statistics are
 * computed from. Asking separately would be three round trips for one answer.
 *
 * In Domo a dataset IS a table - there is no schema layer beneath it - so this
 * returns one table, and the caller presents it as such.
 */
async function getTableProfile({ host, token, datasetId }) {
  const detail = await callDomo(host, token, datasetDetailPath(datasetId));

  const sample = await callDomo(host, token, queryExecutePath(datasetId), {
    method: 'POST',
    body: { sql: `SELECT * FROM table LIMIT ${PROFILE_SAMPLE_ROWS}` },
  });

  const names = Array.isArray(sample && sample.columns) ? sample.columns : [];
  const types = (Array.isArray(sample && sample.metadata) ? sample.metadata : []).map(
    (m) => (m && m.type) || null
  );
  const rows = Array.isArray(sample && sample.rows) ? sample.rows : [];

  const columns = profileColumns(names, types, rows);
  const rowCount = Number.isFinite(Number(detail && (detail.rowCount ?? detail.rows)))
    ? Number(detail.rowCount ?? detail.rows)
    : null;

  return {
    id: String(datasetId),
    datasetId: String(datasetId),
    name: (detail && (detail.name || detail.displayName)) || String(datasetId),
    description: (detail && detail.description) || null,
    rowCount,
    // Domo's own count where it has one; otherwise what the query surface
    // actually returned, which is the same number by a different route.
    columnCount: Number.isFinite(Number(detail && detail.columnCount))
      ? Number(detail.columnCount)
      : columns.length || null,
    /*
     * Domo reports storage under more than one name across instances, and on
     * some it reports none at all. Absent means absent - never estimated from
     * row counts, and never measured by reading the data.
     */
    sizeBytes: firstFiniteNumber(
      detail && detail.sizeInBytes,
      detail && detail.dataSourceSize,
      detail && detail.sizeBytes
    ),
    // Nothing on this API surface scores data quality. Left for whatever does.
    qualityScore: null,
    lastRefreshedAt: (detail && (detail.lastTouched ?? detail.lastUpdated ?? detail.updatedAt)) || null,
    owner:
      detail && detail.owner && typeof detail.owner === 'object'
        ? detail.owner.name || detail.owner.displayName || null
        : (detail && detail.ownerName) || null,
    columns,
    sample: names.length
      ? {
          columns: names,
          rows: rows.slice(0, SAMPLE_ROWS_SHOWN),
          sampledFrom: rowCount,
        }
      : null,
    /** What the column statistics above were computed over. */
    statsSampleSize: rows.length,
    // No quality-issue detection on this surface yet. An empty list is the
    // honest answer: nothing looked, so nothing was found.
    qualityIssues: [],
  };
}

/** The first argument that is a usable number, or null. */
function firstFiniteNumber(...candidates) {
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

module.exports = {
  normaliseHost,
  verify,
  listDatasets,
  getTableProfile,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  PROFILE_SAMPLE_ROWS,
};
