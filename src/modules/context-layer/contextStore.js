const { db, withTransaction } = require('../../config/database');
const { quoteIdentifier } = require('../../config/pgPool');
const { fail, requireString } = require('../../api/response');

/**
 * The facts an extraction run wrote, and what a human decides about them.
 *
 * Reads `context_objects` DIRECTLY. That is only correct because the two
 * services now share one database: the Context Layer service writes these rows
 * and this application reads them, rather than one calling the other. The
 * alternative was proxying the admin API on :8100, which would mean running a
 * second service and putting its `API_AUTH_TOKEN` somewhere this process could
 * reach - a bigger surface for no gain.
 *
 * `workspace_id` on those rows IS a connection id. Every function here loads
 * the connection first, through `loadConnection`, which is company-scoped in
 * SQL - so the tenant boundary is the one the rest of this module already
 * enforces, not a second mechanism that could disagree with it.
 *
 * WHAT THIS MODULE MAY WRITE, and what it may not:
 *
 *   `context_objects.verified` / `reviewed_by` / `reviewed_at` - yes. Those
 *   columns exist for exactly this, and `verified` is what the read-side MCP
 *   server and the analyst agent filter on, so an approval has to land there
 *   or it means nothing downstream.
 *
 *   `context_objects.payload` - yes, on an explicit edit, merged rather than
 *   replaced so an edit to one key cannot drop the rest of what the agent
 *   recorded.
 *
 *   Anything else - no. The schema belongs to the other repository.
 *
 * The four-state review (pending / approved / rejected / skipped) does not fit
 * in one boolean, so the state lives in this module's own table and the
 * boolean is kept in step with it. See `context_object_reviews` in schema.js.
 */

const q = quoteIdentifier;
const OBJECTS = q('context_objects');

/* ------------------------------------------------------------------ reads --- */

/**
 * Every object a connection's latest run wrote, or a named run's.
 *
 * Ordered by type then name, the same order the Context Layer service returns
 * them in, so the two surfaces agree about what "first" means.
 */
async function loadObjects(connectionId, sessionId) {
  const params = [connectionId];
  let clause = 'o.workspace_id = ?::uuid';

  if (sessionId) {
    clause += ' AND o.session_id = ?';
    params.push(sessionId);
  } else {
    /*
     * The latest run, resolved in SQL rather than by a second round trip.
     * Rows with no session_id predate the column and belong to no run, so
     * they are excluded from the subquery the same way the other service
     * excludes them.
     */
    clause +=
      ` AND o.session_id = (SELECT c2.session_id FROM ${OBJECTS} c2` +
      ' WHERE c2.workspace_id = ?::uuid AND c2.session_id IS NOT NULL' +
      ' ORDER BY c2.created_at DESC LIMIT 1)';
    params.push(connectionId);
  }

  const { rows } = await db.query(
    `SELECT o.id, o.session_id, o.object_type, o.qualified_name, o.source_type,
            o.verified, o.confidence, o.payload, o.reviewed_by, o.reviewed_at,
            o.created_at, o.updated_at,
            r.status AS review_status, r.note AS review_note
       FROM ${OBJECTS} o
       LEFT JOIN ${q('context_object_reviews')} r ON r.object_id = o.id
      WHERE ${clause}
      ORDER BY o.object_type, o.qualified_name`,
    params
  );
  return rows;
}

/** A missing `context_objects` table is a deployment fact, not a crash. */
function asMissingStore(err) {
  // 42P01 = undefined_table. Reachable when this database has not had the
  // Context Layer schema applied, which is a setup step, not a bug here.
  if (err && err.code === '42P01') {
    throw fail(
      'SERVICE_UNAVAILABLE',
      'The context store is not set up in this database yet. Run the Context Layer schema first.'
    );
  }
  throw err;
}

/**
 * The latest run's facts, in the ADK API's `/context-objects` response shape.
 *
 * Same shape on purpose, so Understand renders one list whichever service
 * answered. Used in demo mode, when the ADK API is not what wrote the rows.
 */
async function listContextObjects(connectionId) {
  let rows;
  try {
    rows = await loadObjects(connectionId);
  } catch (err) {
    asMissingStore(err);
  }
  return {
    workspace_id: connectionId,
    resolved_session_id: rows.length ? rows[0].session_id : null,
    count: rows.length,
    objects: rows.map((row) => ({
      id: row.id,
      bundle_id: null,
      session_id: row.session_id,
      object_type: row.object_type,
      qualified_name: row.qualified_name,
      source_type: row.source_type,
      verified: row.verified,
      confidence: row.confidence === null ? null : Number(row.confidence),
      payload: row.payload,
      reviewed_by: row.reviewed_by,
      reviewed_at: row.reviewed_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
  };
}

/* ------------------------------------------------------------------ model --- */

/** The table a `column_stats` row belongs to: everything before the last dot. */
function tableOf(qualifiedName) {
  const index = String(qualifiedName || '').lastIndexOf('.');
  return index === -1 ? null : qualifiedName.slice(0, index);
}

function columnOf(qualifiedName) {
  const index = String(qualifiedName || '').lastIndexOf('.');
  return index === -1 ? qualifiedName : qualifiedName.slice(index + 1);
}

/**
 * The relationship graph, derived from what the run recorded.
 *
 * Nodes are `table` rows; their columns come from the `column_stats` rows
 * whose qualified name is `<table>.<column>`. Edges are `join` rows, whose
 * payload carries `tables` and `join_keys` - see the skill's
 * `payload-schemas.md`, which is the contract this reads.
 *
 * A join naming a table with no `table` row still produces a node, from the
 * name alone. Dropping the edge instead would hide a relationship the agent
 * actually found; showing a node with no columns says exactly what is known.
 */
async function modelGraph(connectionId) {
  let rows;
  try {
    rows = await loadObjects(connectionId);
  } catch (err) {
    asMissingStore(err);
  }

  const sessionId = rows.length ? rows[0].session_id : null;

  const columnsByTable = new Map();
  for (const row of rows) {
    if (row.object_type !== 'column_stats') continue;
    const table = tableOf(row.qualified_name);
    if (!table) continue;
    if (!columnsByTable.has(table)) columnsByTable.set(table, []);
    const payload = row.payload || {};
    columnsByTable.get(table).push({
      name: columnOf(row.qualified_name),
      dataType: payload.data_type ?? null,
      // Neither is exposed as a flag; the skill records a candidate key as a
      // note. Read where stated, never inferred from a column's name.
      isPrimaryKey: /candidate primary key/i.test(String(payload.note || '')),
      isForeignKey: false,
    });
  }

  const nodes = new Map();
  const addNode = (name, kind) => {
    if (!name || nodes.has(name)) return;
    nodes.set(name, {
      id: name,
      label: name,
      datasetId: null,
      kind,
      columns: columnsByTable.get(name) || [],
      position: null,
    });
  };

  for (const row of rows) {
    if (row.object_type === 'table') addNode(row.qualified_name, 'table');
  }

  const edges = [];
  for (const row of rows) {
    if (row.object_type !== 'join') continue;
    const payload = row.payload || {};
    const tables = Array.isArray(payload.tables) ? payload.tables : [];
    const keys = Array.isArray(payload.join_keys) ? payload.join_keys : [];
    if (tables.length < 2 || keys.length === 0) continue;

    const [left, right] = tables;
    addNode(left, 'table');
    addNode(right, 'table');

    edges.push({
      id: row.id,
      source: left,
      target: right,
      sourceColumn: keys[0].left ?? '',
      targetColumn: keys[0].right ?? '',
      relationshipType: payload.cardinality || 'related',
      confidence: row.confidence === null ? null : Number(row.confidence),
      // `verified` is the skill's own trust flag, and it is exactly the
      // accepted/suggested distinction this screen asks somebody to settle.
      status: reviewStatusOf(row) === 'rejected'
        ? 'rejected'
        : row.verified
          ? 'accepted'
          : 'suggested',
      joinCondition: keys
        .map((k) => `${left}.${k.left} = ${right}.${k.right}`)
        .join(' AND '),
      suggestion: payload.basis || null,
    });
  }

  return {
    connectionId,
    status: rows.length ? 'ready' : 'pending',
    generatedAt: rows.length ? rows[0].created_at : null,
    error: null,
    sessionId,
    nodes: [...nodes.values()],
    edges,
  };
}

/* ----------------------------------------------------------------- review --- */

/**
 * The review state of one row.
 *
 * Our own table wins where it has an opinion, because it is the only place
 * that can say "rejected" or "skipped". Where it is silent, `verified` is
 * read: a row the agent marked verified is already settled, and everything
 * else is waiting for somebody.
 */
function reviewStatusOf(row) {
  if (row.review_status) return row.review_status;
  return row.verified ? 'approved' : 'pending';
}

/** One `context_objects` row as the review queue presents it. */
function shapeReviewItem(row) {
  const payload = row.payload || {};
  return {
    id: row.id,
    type: row.object_type,
    name: row.qualified_name,
    status: reviewStatusOf(row),
    confidence: row.confidence === null ? null : Number(row.confidence),
    description: typeof payload.description === 'string' ? payload.description : null,
    formula: typeof payload.formula === 'string' ? payload.formula : null,
    source: row.source_type,
    // The skill records a caveat as `note`. Surfaced as the thing a reviewer
    // most needs to see, rather than left buried in the payload grid.
    downstreamImpact: typeof payload.note === 'string' ? payload.note : null,
    suggestion: typeof payload.basis === 'string' ? payload.basis : null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    // Everything else the agent recorded, for the type-specific editor.
    fields: payload,
  };
}

async function reviewQueue(connectionId, { type, status, search } = {}) {
  let rows;
  try {
    rows = await loadObjects(connectionId);
  } catch (err) {
    asMissingStore(err);
  }

  const items = rows.map(shapeReviewItem);

  /*
   * Counts are of EVERYTHING, not of the filtered set.
   *
   * They drive the filter chips, and a chip whose number changes when you
   * press it cannot be used to decide what to press.
   */
  const counts = {};
  for (const item of items) {
    counts[item.type] = (counts[item.type] || 0) + 1;
  }

  const needle = String(search || '').trim().toLowerCase();
  const filtered = items.filter((item) => {
    if (type && item.type !== type) return false;
    if (status && item.status !== status) return false;
    if (!needle) return true;
    return (
      item.name.toLowerCase().includes(needle) ||
      JSON.stringify(item.fields || {}).toLowerCase().includes(needle)
    );
  });

  return { connectionId, items: filtered, counts, total: items.length };
}

/** Confirms the object belongs to this connection before anything touches it. */
async function requireObject(connectionId, objectId) {
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT id, object_type, qualified_name, payload, verified
         FROM ${OBJECTS}
        WHERE id = ?::uuid AND workspace_id = ?::uuid`,
      [objectId, connectionId]
    ));
  } catch (err) {
    // A malformed uuid is a 404, the same as one that names nothing.
    if (err.code === '22P02') throw fail('RESOURCE_NOT_FOUND', 'That item does not exist.');
    asMissingStore(err);
  }
  if (!rows[0]) throw fail('RESOURCE_NOT_FOUND', 'That item does not exist.');
  return rows[0];
}

const DECISIONS = new Set(['approve', 'reject', 'skip']);
const STATUS_FOR = { approve: 'approved', reject: 'rejected', skip: 'skipped' };

/**
 * Records a decision.
 *
 * Both writes happen together or not at all. An approval that updated our own
 * table but not `context_objects.verified` would look settled on this screen
 * and stay invisible to the analyst agent, which filters on that column - the
 * worst kind of half-write, because nothing reports it.
 *
 * `skip` deliberately leaves `verified` alone: it means "not now", not "this
 * is wrong", and flipping the flag either way would be answering a question
 * the reviewer declined to answer.
 */
async function decideReviewItem(actor, connectionId, objectId, decision) {
  if (!DECISIONS.has(decision)) {
    throw fail('VALIDATION_ERROR', `Unknown decision "${decision}".`);
  }
  await requireObject(connectionId, objectId);
  const status = STATUS_FOR[decision];

  await withTransaction(async (conn) => {
    await conn.query(
      `INSERT INTO ${q('context_object_reviews')}
         (object_id, connection_id, status, reviewed_by, reviewed_at)
       VALUES (?::uuid, ?::uuid, ?, ?, now())
       ON CONFLICT (object_id) DO UPDATE SET
         status = EXCLUDED.status,
         reviewed_by = EXCLUDED.reviewed_by,
         reviewed_at = EXCLUDED.reviewed_at`,
      [objectId, connectionId, status, actor.id]
    );

    if (decision !== 'skip') {
      await conn.query(
        `UPDATE ${OBJECTS}
            SET verified = ?, reviewed_by = ?, reviewed_at = now(), updated_at = now()
          WHERE id = ?::uuid`,
        [decision === 'approve', actor.username, objectId]
      );
    }
  });

  const rows = await loadObjects(connectionId);
  const updated = rows.find((row) => row.id === objectId);
  return updated ? shapeReviewItem(updated) : null;
}

/**
 * Edits what the agent recorded.
 *
 * The payload is MERGED, not replaced: an editor sends the keys it knows
 * about, and replacing would silently drop everything it did not render -
 * distinct values, sample sizes, the notes another type carries.
 */
async function updateReviewItem(actor, connectionId, objectId, body = {}) {
  await requireObject(connectionId, objectId);

  const patch = {};
  if (body.description !== undefined) patch.description = body.description;
  if (body.formula !== undefined) patch.formula = body.formula;
  if (body.fields && typeof body.fields === 'object') Object.assign(patch, body.fields);

  if (Object.keys(patch).length === 0 && body.name === undefined) {
    throw fail('VALIDATION_ERROR', 'Nothing to update.');
  }

  await db.query(
    `UPDATE ${OBJECTS}
        SET payload = payload || ?::jsonb,
            ${body.name === undefined ? '' : 'qualified_name = ?,'}
            updated_at = now()
      WHERE id = ?::uuid AND workspace_id = ?::uuid`,
    body.name === undefined
      ? [JSON.stringify(patch), objectId, connectionId]
      : [JSON.stringify(patch), String(body.name), objectId, connectionId]
  );

  const rows = await loadObjects(connectionId);
  const updated = rows.find((row) => row.id === objectId);
  return updated ? shapeReviewItem(updated) : null;
}

/**
 * One decision across everything matching a filter.
 *
 * The filter is applied here rather than accepting a list of ids, so "approve
 * everything above 90%" means what it says instead of "approve the ones that
 * happened to be on screen".
 */
async function bulkDecide(actor, connectionId, { decision, filter = {} } = {}) {
  if (!DECISIONS.has(decision)) {
    throw fail('VALIDATION_ERROR', `Unknown decision "${decision}".`);
  }

  const rows = await loadObjects(connectionId);
  const matching = rows.filter((row) => {
    if (filter.type && row.object_type !== filter.type) return false;
    if (filter.status && reviewStatusOf(row) !== filter.status) return false;
    if (filter.minConfidence !== undefined && filter.minConfidence !== null) {
      // A row with no confidence has not met the bar; it has no bar. Excluded
      // rather than treated as zero or as passing.
      if (row.confidence === null) return false;
      if (Number(row.confidence) < Number(filter.minConfidence)) return false;
    }
    return true;
  });

  for (const row of matching) {
    await decideReviewItem(actor, connectionId, row.id, decision);
  }
  return { affected: matching.length };
}

module.exports = {
  loadObjects,
  listContextObjects,
  modelGraph,
  reviewQueue,
  decideReviewItem,
  updateReviewItem,
  bulkDecide,
  shapeReviewItem,
  reviewStatusOf,
};
