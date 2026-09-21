const crypto = require('crypto');
const { db } = require('../../config/database');
const { UNIQUE_VIOLATION } = require('../../config/pgPool');
const { fail, requireString } = require('../../api/response');
const { companyScope } = require('../../auth/authorization');
const { CT } = require('./schema');
const { seal, open, hint } = require('./secretBox');
const domo = require('./providers/domo');

/**
 * Saved warehouse connections, and the datasets chosen from them.
 *
 * Every read takes the acting user and filters by company in SQL, the same way
 * userService does - so a company administrator changing an id in a URL reaches
 * a 404 rather than another tenant's Domo credential. That matters more here
 * than almost anywhere else in the application: the row holds a live token for
 * somebody else's warehouse.
 *
 * The decrypted token never leaves this module. `shapeConnection` cannot
 * accidentally include it, because it is not given the column.
 */

/** Providers with a working implementation, by id. */
const PROVIDERS = { domo };

function providerFor(id) {
  const provider = PROVIDERS[String(id || '').trim().toLowerCase()];
  if (!provider) {
    throw fail('VALIDATION_ERROR', `"${id}" is not a connector that can be configured yet.`);
  }
  return provider;
}

const COLUMNS = `c.id, c.company_id, c.provider, c.name, c.host, c.secret_hint,
                 c.status, c.last_error, c.last_verified_at, c.created_at`;

/** Safe to hand to a browser: describes the credential, never carries it. */
function shapeConnection(row, datasets) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    provider: row.provider,
    name: row.name,
    host: row.host,
    secretHint: row.secret_hint,
    status: row.status,
    lastError: row.last_error || null,
    lastVerifiedAt: row.last_verified_at || null,
    createdAt: row.created_at || null,
    selectedDatasetCount: row.selectedDatasetCount === undefined
      ? undefined
      : Number(row.selectedDatasetCount),
    selectedDatasets: datasets,
  };
}

function shapeSelected(row) {
  return {
    id: row.dataset_id,
    name: row.name,
    rowCount: row.row_count === null ? null : Number(row.row_count),
    columnCount: row.column_count === null ? null : Number(row.column_count),
    selectedAt: row.selected_at,
  };
}

/* ------------------------------------------------------------------ reads --- */

async function listConnections(actor) {
  const scope = companyScope(actor, 'c.company_id');
  const { rows } = await db.query(
    `SELECT ${COLUMNS},
            (SELECT COUNT(*) FROM ${CT.datasets} d WHERE d.connection_id = c.id) AS "selectedDatasetCount"
       FROM ${CT.connections} c
      WHERE ${scope.clause}
      ORDER BY c.provider, c.name`,
    scope.params
  );
  return rows.map((row) => shapeConnection(row));
}

/**
 * The full row including the sealed secret, or a 404.
 *
 * Internal: the only callers are the ones that are about to call the
 * warehouse. Everything that answers a request goes through
 * `requireConnection`, which returns the shaped version.
 */
async function loadRow(actor, id) {
  if (typeof id !== 'string' || !id.trim()) {
    throw fail('RESOURCE_NOT_FOUND', 'Connection not found');
  }

  const scope = companyScope(actor, 'c.company_id');
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT ${COLUMNS}, c.secret
         FROM ${CT.connections} c
        WHERE c.id = ? AND ${scope.clause}`,
      [id, ...scope.params]
    ));
  } catch (err) {
    // An id that is not a UUID is a 404, not a 500: it is the same class of
    // mistake as a UUID that names nothing, and the caller learns the same
    // thing from both.
    if (err.code === '22P02') throw fail('RESOURCE_NOT_FOUND', 'Connection not found');
    throw err;
  }

  if (!rows[0]) throw fail('RESOURCE_NOT_FOUND', 'Connection not found');
  return rows[0];
}

async function selectedDatasets(connectionId) {
  const { rows } = await db.query(
    `SELECT dataset_id, name, row_count, column_count, selected_at
       FROM ${CT.datasets}
      WHERE connection_id = ?
      ORDER BY name NULLS LAST, dataset_id`,
    [connectionId]
  );
  return rows.map(shapeSelected);
}

/** One connection as the caller may see it, with its chosen datasets. */
async function requireConnection(actor, id) {
  const row = await loadRow(actor, id);
  return shapeConnection(row, await selectedDatasets(row.id));
}

/* ----------------------------------------------------------------- writes --- */

/**
 * Validates the credential against the warehouse, then saves it.
 *
 * In that order, deliberately. A connection row whose token was never checked
 * is indistinguishable on screen from one that works, and the moment it is
 * relied on is the moment somebody is waiting for a context that will never
 * build. If the token is refused, nothing is written.
 */
async function createConnection(actor, companyId, { provider, name, host, token }) {
  const impl = providerFor(provider);
  const providerId = String(provider).trim().toLowerCase();

  const cleanName = requireString(name, 'Connection name', { min: 2, max: 120 });
  const cleanHost = impl.normaliseHost(host);
  const cleanToken = String(token || '').trim();
  if (!cleanToken) {
    throw fail('VALIDATION_ERROR', 'The access token is required.');
  }

  const account = await impl.verify({ host: cleanHost, token: cleanToken });
  const datasets = await impl.listDatasets({ host: cleanHost, token: cleanToken });

  const id = crypto.randomUUID();
  try {
    await db.query(
      `INSERT INTO ${CT.connections}
         (id, company_id, provider, name, host, secret, secret_hint, status, last_verified_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'connected', now(), ?)`,
      [id, companyId, providerId, cleanName, cleanHost, seal(cleanToken), hint(cleanToken), actor.id]
    );
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      throw fail('CONFLICT', `This company already has a ${providerId} connection called "${cleanName}".`);
    }
    throw err;
  }

  const row = await loadRow(actor, id);
  return { connection: shapeConnection(row, []), account, datasets };
}

/**
 * Asks the warehouse for its datasets, live.
 *
 * Not cached. The picker exists to choose from what is there now, and a stale
 * list here means selecting a dataset id that no longer resolves - which fails
 * later, somewhere else, for a reason nobody can see from this screen.
 *
 * The connection's status is updated from the outcome either way, so a token
 * that has since been revoked is visibly broken on the list rather than only
 * when somebody opens it.
 */
async function fetchDatasets(actor, id) {
  const row = await loadRow(actor, id);
  const impl = providerFor(row.provider);

  let token;
  try {
    token = open(row.secret);
  } catch {
    await markStatus(row.id, 'invalid', 'The stored credential could not be decrypted.');
    throw fail(
      'CONNECTOR_AUTH_FAILED',
      'The stored token for this connection could not be read. It has to be entered again.'
    );
  }

  try {
    const datasets = await impl.listDatasets({ host: row.host, token });
    await markStatus(row.id, 'connected', null);
    return datasets;
  } catch (err) {
    // Only a refused credential marks the connection broken. An instance that
    // is briefly unreachable is not a reason to tell somebody their token is
    // wrong.
    if (err.code === 'CONNECTOR_AUTH_FAILED') {
      await markStatus(row.id, 'invalid', err.message);
    }
    throw err;
  }
}

async function markStatus(id, status, lastError) {
  await db.query(
    `UPDATE ${CT.connections}
        SET status = ?, last_error = ?, last_verified_at = CASE WHEN ? = 'connected' THEN now() ELSE last_verified_at END
      WHERE id = ?`,
    [status, lastError, status, id]
  );
}

/** Re-checks the credential and records the answer. */
async function verifyConnection(actor, id) {
  const row = await loadRow(actor, id);
  const impl = providerFor(row.provider);

  let token;
  try {
    token = open(row.secret);
  } catch {
    await markStatus(row.id, 'invalid', 'The stored credential could not be decrypted.');
    throw fail(
      'CONNECTOR_AUTH_FAILED',
      'The stored token for this connection could not be read. It has to be entered again.'
    );
  }

  try {
    const account = await impl.verify({ host: row.host, token });
    await markStatus(row.id, 'connected', null);
    return { connection: await requireConnection(actor, id), account };
  } catch (err) {
    if (err.code === 'CONNECTOR_AUTH_FAILED') {
      await markStatus(row.id, 'invalid', err.message);
    }
    throw err;
  }
}

/**
 * Replaces the whole selection with `datasets`.
 *
 * A replace rather than an add: the screen presents a set of checkboxes, and
 * what the person means by pressing save is "this is the selection", including
 * the ones they cleared. Diffing two lists client-side to send only the
 * changes is how a cleared box survives a save.
 */
async function replaceSelection(actor, id, datasets) {
  const row = await loadRow(actor, id);

  if (!Array.isArray(datasets)) {
    throw fail('VALIDATION_ERROR', 'Expected a list of datasets.');
  }

  const clean = [];
  const seen = new Set();
  for (const entry of datasets) {
    const source = typeof entry === 'string' ? { id: entry } : (entry || {});
    const datasetId = String(source.id || '').trim();
    if (!datasetId) continue;
    if (datasetId.length > 190) {
      throw fail('VALIDATION_ERROR', 'A dataset id is longer than this connector allows.');
    }
    if (seen.has(datasetId)) continue;
    seen.add(datasetId);
    clean.push({
      id: datasetId,
      name: source.name ? String(source.name).slice(0, 255) : null,
      rowCount: Number.isFinite(Number(source.rowCount)) ? Number(source.rowCount) : null,
      columnCount: Number.isFinite(Number(source.columnCount)) ? Number(source.columnCount) : null,
    });
  }

  await db.transaction(async (conn) => {
    await conn.query(`DELETE FROM ${CT.datasets} WHERE connection_id = ?`, [row.id]);
    for (const dataset of clean) {
      await conn.query(
        `INSERT INTO ${CT.datasets}
           (connection_id, dataset_id, name, row_count, column_count, selected_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [row.id, dataset.id, dataset.name, dataset.rowCount, dataset.columnCount, actor.id]
      );
    }
  });

  return requireConnection(actor, id);
}

async function deleteConnection(actor, id) {
  const row = await loadRow(actor, id);
  await db.query(`DELETE FROM ${CT.connections} WHERE id = ?`, [row.id]);
  return { provider: row.provider, name: row.name };
}

module.exports = {
  listConnections,
  requireConnection,
  createConnection,
  fetchDatasets,
  verifyConnection,
  replaceSelection,
  deleteConnection,
};
