const crypto = require('crypto');
const { db, withTransaction } = require('../../config/database');
const { fail } = require('../../api/response');
const { CT } = require('./schema');

/**
 * The lifecycle of a context: draft while it is being built, published once
 * somebody publishes it, and a NEW draft - the next version - the moment it is
 * edited after that.
 *
 * Two rules carry the whole design:
 *
 *   A draft is opened by a WRITE, never by looking. Saving a selection,
 *   running an extraction, deciding a review item - each calls `touchDraft`,
 *   which reuses the connection's open draft or opens one. Merely stepping
 *   through the builder only moves `current_step` on a draft that already
 *   exists, so opening a published context to read it does not mint a v2 that
 *   nobody asked for.
 *
 *   A published row is never written again. Editing after publication opens
 *   version n+1 beside it, so what was published stays exactly as it was.
 *
 * These are server-side on purpose: the routes that change something call
 * this module themselves, rather than trusting the screen to remember to.
 */

const STEPS = ['connect', 'discover', 'profile', 'understand', 'model', 'review', 'publish'];

function stepRank(step) {
  const index = STEPS.indexOf(step);
  return index === -1 ? -1 : index;
}

/** The further of two steps. A write in Discover does not rewind a draft at Review. */
function furthest(a, b) {
  return stepRank(b) > stepRank(a) ? b : a;
}

function shapeVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    connectionId: row.connection_id,
    name: row.name,
    version: Number(row.version),
    label: `v${row.version}`,
    status: row.status,
    currentStep: row.current_step,
    datasetIds: Array.isArray(row.dataset_ids) ? row.dataset_ids : [],
    basedOnId: row.based_on_id,
    sessionId: row.session_id,
    extractionMode: row.extraction_mode,
    extractedAt: row.extracted_at,
    objectCount: Number(row.object_count || 0),
    stats: row.stats || {},
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedBy: row.published_by,
    publishedAt: row.published_at,
  };
}

// Everything except the snapshot, which can be large and is only read on publish.
const COLUMNS = `id, connection_id, name, version, status, current_step, dataset_ids,
  based_on_id, session_id, extraction_mode, extracted_at, object_count, stats,
  created_by, created_at, updated_at, published_by, published_at`;

async function listVersions(connectionId) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM ${CT.versions}
      WHERE connection_id = ?::uuid
      ORDER BY created_at DESC, version DESC`,
    [connectionId]
  );
  return rows;
}

/**
 * Where a connection's context stands.
 *
 * `status` is the headline the builder shows: `draft` while one is open,
 * otherwise `published` if any version ever was, otherwise `none`.
 */
async function versionState(connection) {
  const rows = await listVersions(connection.id);
  const draft = rows.find((row) => row.status === 'draft') || null;
  const published = rows
    .filter((row) => row.status === 'published')
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

  return {
    connectionId: connection.id,
    status: draft ? 'draft' : published.length ? 'published' : 'none',
    draft: shapeVersion(draft),
    latestPublished: shapeVersion(published[0] || null),
    versions: rows.map(shapeVersion),
  };
}

/** The next version number for a name, not counting one row (the draft being renamed). */
async function nextVersion(conn, connectionId, name, excludeId = null) {
  const { rows } = await conn.query(
    `SELECT COALESCE(MAX(version), 0) AS v
       FROM ${CT.versions}
      WHERE connection_id = ?::uuid AND name = ?
        AND (?::uuid IS NULL OR id <> ?::uuid)`,
    [connectionId, name, excludeId, excludeId]
  );
  return Number(rows[0].v) + 1;
}

/**
 * The open draft, locked for the rest of the transaction. Null when there is none.
 */
async function lockDraft(conn, connectionId) {
  const { rows } = await conn.query(
    `SELECT * FROM ${CT.versions}
      WHERE connection_id = ?::uuid AND status = 'draft'
      FOR UPDATE`,
    [connectionId]
  );
  return rows[0] || null;
}

/**
 * Opens a draft inside `conn`. Named after the latest publication, so editing
 * "Revenue" v1 opens "Revenue" v2; a context never published takes the
 * connection's own name as its starting point.
 */
async function openDraft(conn, actor, connection, step) {
  const { rows: latest } = await conn.query(
    `SELECT id, name FROM ${CT.versions}
      WHERE connection_id = ?::uuid AND status = 'published'
      ORDER BY published_at DESC
      LIMIT 1`,
    [connection.id]
  );
  const basedOn = latest[0] || null;
  const name = basedOn ? basedOn.name : String(connection.name).slice(0, 120);
  const version = await nextVersion(conn, connection.id, name);

  const { rows } = await conn.query(
    `INSERT INTO ${CT.versions}
       (id, connection_id, company_id, name, version, status, current_step,
        dataset_ids, based_on_id, created_by)
     VALUES (?::uuid, ?::uuid, ?, ?, ?, 'draft', ?, ?::jsonb, ?::uuid, ?)
     RETURNING *`,
    [
      crypto.randomUUID(),
      connection.id,
      connection.companyId,
      name,
      version,
      step || null,
      JSON.stringify((connection.selectedDatasets || []).map((d) => d.id)),
      basedOn ? basedOn.id : null,
      actor ? actor.id : null,
    ]
  );
  return rows[0];
}

/**
 * Records that something about this context changed, opening a draft if none
 * is open.
 *
 * `patch` sets any of: `step` (only ever moves forward), `datasetIds`, and the
 * extraction fields. Returns the draft as it now stands.
 *
 * Two simultaneous first writes would both find no draft and both insert; the
 * partial unique index lets exactly one win, and the loser retries once, finds
 * the winner's draft and updates that instead.
 */
async function touchDraft(actor, connection, patch = {}, attempt = 0) {
  try {
    const row = await withTransaction(async (conn) => {
      let draft = await lockDraft(conn, connection.id);
      if (!draft) draft = await openDraft(conn, actor, connection, patch.step);

      const sets = ['updated_at = now()'];
      const params = [];
      const step = patch.step ? furthest(draft.current_step, patch.step) : null;
      if (step && step !== draft.current_step) {
        sets.push('current_step = ?');
        params.push(step);
      }
      if (Array.isArray(patch.datasetIds)) {
        sets.push('dataset_ids = ?::jsonb');
        params.push(JSON.stringify(patch.datasetIds));
      }
      if (patch.sessionId !== undefined) {
        sets.push('session_id = ?');
        params.push(patch.sessionId);
      }
      if (patch.extractionReport !== undefined) {
        sets.push('extraction_report = ?', 'extraction_mode = ?', 'extracted_at = now()');
        params.push(patch.extractionReport, patch.extractionMode || null);
      }

      const { rows } = await conn.query(
        `UPDATE ${CT.versions} SET ${sets.join(', ')} WHERE id = ?::uuid RETURNING *`,
        [...params, draft.id]
      );
      return rows[0];
    });
    return shapeVersion(row);
  } catch (err) {
    if (err.code === '23505' && attempt === 0) {
      return touchDraft(actor, connection, patch, attempt + 1);
    }
    throw err;
  }
}

/**
 * Moves the open draft's step marker. Never opens a draft - see the header.
 * Returns null when there is no draft to move.
 */
async function trackStep(connection, step) {
  if (!STEPS.includes(step)) {
    throw fail('VALIDATION_ERROR', `Unknown step "${step}".`);
  }
  const { rows } = await db.query(
    `UPDATE ${CT.versions}
        SET current_step = ?, updated_at = now()
      WHERE connection_id = ?::uuid AND status = 'draft'
      RETURNING ${COLUMNS}`,
    [step, connection.id]
  );
  return shapeVersion(rows[0] || null);
}

/**
 * Turns the open draft into a published version, inside the caller's
 * transaction. Opens and publishes in one go when there is no draft, which
 * happens for a connection built before drafts existed.
 *
 * The version is recomputed for the name being published under - excluding
 * the draft's own row, whose number was only provisional.
 */
async function publishDraft(conn, actor, connection, { name, snapshot, stats, sessionId, notifyTeam }) {
  let draft = await lockDraft(conn, connection.id);
  if (!draft) draft = await openDraft(conn, actor, connection, 'publish');

  const version = await nextVersion(conn, connection.id, name, draft.id);

  const { rows } = await conn.query(
    `UPDATE ${CT.versions}
        SET name = ?, version = ?, status = 'published', current_step = 'publish',
            session_id = COALESCE(?, session_id),
            object_count = ?, stats = ?::jsonb, snapshot = ?::jsonb, notify_team = ?,
            published_by = ?, published_at = now(), updated_at = now()
      WHERE id = ?::uuid
      RETURNING ${COLUMNS}`,
    [
      name,
      version,
      sessionId,
      snapshot.length,
      JSON.stringify(stats),
      JSON.stringify(snapshot),
      Boolean(notifyTeam),
      actor.id,
      draft.id,
    ]
  );
  return shapeVersion(rows[0]);
}

/** The latest published version, or null. */
async function latestPublished(connectionId) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM ${CT.versions}
      WHERE connection_id = ?::uuid AND status = 'published'
      ORDER BY published_at DESC
      LIMIT 1`,
    [connectionId]
  );
  return shapeVersion(rows[0] || null);
}

/** The open draft, or null. */
async function currentDraft(connectionId) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM ${CT.versions}
      WHERE connection_id = ?::uuid AND status = 'draft'`,
    [connectionId]
  );
  return shapeVersion(rows[0] || null);
}

/**
 * The most recent extraction report across every version of this context.
 *
 * Across versions rather than only the draft's, so Understand still shows the
 * run a published v1 was built from after its draft has become published.
 */
async function latestExtraction(connectionId) {
  const { rows } = await db.query(
    `SELECT session_id, extraction_mode, extraction_report, extracted_at
       FROM ${CT.versions}
      WHERE connection_id = ?::uuid AND extraction_report IS NOT NULL
      ORDER BY extracted_at DESC
      LIMIT 1`,
    [connectionId]
  );
  return rows[0] || null;
}

/**
 * The context headline for each connection in a list, keyed by connection id -
 * one query for the whole landing page rather than one per card.
 */
async function statusByConnection(connectionIds) {
  if (!connectionIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT DISTINCT ON (connection_id)
            connection_id, name, version, status, published_at, updated_at
       FROM ${CT.versions}
      WHERE connection_id = ANY(?::uuid[])
      ORDER BY connection_id, (status = 'draft') DESC, updated_at DESC`,
    [connectionIds]
  );
  return new Map(
    rows.map((row) => [
      row.connection_id,
      {
        name: row.name,
        version: Number(row.version),
        label: `v${row.version}`,
        status: row.status,
        publishedAt: row.published_at,
        updatedAt: row.updated_at,
      },
    ])
  );
}

module.exports = {
  STEPS,
  versionState,
  touchDraft,
  trackStep,
  publishDraft,
  latestPublished,
  currentDraft,
  latestExtraction,
  statusByConnection,
  shapeVersion,
};
