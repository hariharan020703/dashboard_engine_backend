const { db, withTransaction } = require('../../config/database');
const { quoteIdentifier } = require('../../config/pgPool');
const { fail, requireString } = require('../../api/response');
const { likePattern } = require('../../api/listQuery');

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
/**
 * The WHERE clause selecting one run of a connection: the named session, or
 * the latest one - resolved in SQL rather than by a second round trip. Rows
 * with no session_id predate the column and belong to no run, so they are
 * excluded from the subquery the same way the other service excludes them.
 */
function runClause(connectionId, sessionId) {
  if (sessionId) {
    return { sql: 'o.workspace_id = ?::uuid AND o.session_id = ?', params: [connectionId, sessionId] };
  }
  return {
    sql:
      'o.workspace_id = ?::uuid' +
      ` AND o.session_id = (SELECT c2.session_id FROM ${OBJECTS} c2` +
      ' WHERE c2.workspace_id = ?::uuid AND c2.session_id IS NOT NULL' +
      ' ORDER BY c2.created_at DESC LIMIT 1)',
    params: [connectionId, connectionId],
  };
}

/*
 * The review state of a row, in SQL - the same rule as reviewStatusOf():
 * our own table wins where it has an opinion, else `verified` decides.
 */
const STATUS_SQL = `COALESCE(r.status, CASE WHEN o.verified THEN 'approved' ELSE 'pending' END)`;

const REVIEWS = q('context_object_reviews');

/**
 * `types` narrows the read to the object types a caller actually uses - the
 * glossary needs three of the eight, and column_stats (one row per column, the
 * bulk of a run) is never among them.
 */
async function loadObjects(connectionId, sessionId, { types } = {}) {
  const run = runClause(connectionId, sessionId);
  let clause = run.sql;
  const params = [...run.params];
  if (types && types.length) {
    clause += ' AND o.object_type = ANY(?)';
    params.push(types);
  }

  const { rows } = await db.query(
    `SELECT o.id, o.session_id, o.object_type, o.qualified_name, o.source_type,
            o.verified, o.confidence, o.payload, o.reviewed_by, o.reviewed_at,
            o.created_at, o.updated_at,
            r.status AS review_status, r.note AS review_note,
            r.edited AS review_edited, r.reviewed_at AS review_reviewed_at
       FROM ${OBJECTS} o
       LEFT JOIN ${REVIEWS} r ON r.object_id = o.id
      WHERE ${clause}
      ORDER BY o.object_type, o.qualified_name`,
    params
  );
  return rows;
}

/** One object of a connection with its review state, or null. */
async function loadObject(connectionId, objectId) {
  const { rows } = await db.query(
    `SELECT o.id, o.session_id, o.object_type, o.qualified_name, o.source_type,
            o.verified, o.confidence, o.payload, o.reviewed_by, o.reviewed_at,
            o.created_at, o.updated_at,
            r.status AS review_status, r.edited AS review_edited,
            r.reviewed_at AS review_reviewed_at
       FROM ${OBJECTS} o
       LEFT JOIN ${REVIEWS} r ON r.object_id = o.id
      WHERE o.id = ?::uuid AND o.workspace_id = ?::uuid`,
    [objectId, connectionId]
  );
  return rows[0] || null;
}

const MAX_PAGE_SIZE = 100;

/** page/pageSize from a request, bounded. */
function pageOf({ page, pageSize } = {}, defaultSize) {
  const p = Number.isInteger(Number(page)) && Number(page) >= 1 ? Number(page) : 1;
  const sizeRaw = Number(pageSize);
  const size = Number.isInteger(sizeRaw) && sizeRaw >= 1 ? Math.min(sizeRaw, MAX_PAGE_SIZE) : defaultSize;
  return { page: p, pageSize: size, offset: (p - 1) * size };
}

/**
 * One filtered, paged slice of a run, plus the per-type counts of the WHOLE
 * run - in two concurrent statements, so neither the full row set nor any
 * payload outside the page ever leaves the database.
 *
 * Search matches the qualified name and the payload's text, which is what the
 * browser-side search matched (JSON.stringify of the payload) before.
 */
async function pageObjects(connectionId, { sessionId, type, status, search, page, pageSize }, defaultSize) {
  const run = runClause(connectionId, sessionId);
  const where = [run.sql];
  const params = [...run.params];
  if (type) {
    where.push('o.object_type = ?');
    params.push(String(type));
  }
  if (status) {
    where.push(`${STATUS_SQL} = ?`);
    params.push(String(status));
  }
  const needle = String(search || '').trim().slice(0, 100);
  if (needle) {
    where.push('(o.qualified_name ILIKE ? OR o.payload::text ILIKE ?)');
    const pattern = likePattern(needle);
    params.push(pattern, pattern);
  }
  const paging = pageOf({ page, pageSize }, defaultSize);

  const [pageResult, countResult] = await Promise.all([
    db.query(
      `SELECT o.id, o.session_id, o.object_type, o.qualified_name, o.source_type,
              o.verified, o.confidence, o.payload, o.created_at,
              r.status AS review_status, r.edited AS review_edited,
              COUNT(*) OVER () AS "__matched"
         FROM ${OBJECTS} o
         LEFT JOIN ${REVIEWS} r ON r.object_id = o.id
        WHERE ${where.join(' AND ')}
        ORDER BY o.object_type, o.qualified_name, o.id
        LIMIT ? OFFSET ?`,
      [...params, paging.pageSize, paging.offset]
    ),
    db.query(
      `SELECT o.object_type, COUNT(*)::int AS n, MIN(o.session_id) AS session_id
         FROM ${OBJECTS} o
        WHERE ${run.sql}
        GROUP BY o.object_type
        ORDER BY o.object_type`,
      run.params
    ),
  ]);

  const rows = pageResult.rows;
  const counts = {};
  let all = 0;
  for (const row of countResult.rows) {
    counts[row.object_type] = row.n;
    all += row.n;
  }
  let matched = rows.length ? Number(rows[0].__matched) : 0;
  if (!rows.length && paging.offset > 0) {
    // A page past the end carries no window count; recount the rare case.
    const { rows: recount } = await db.query(
      `SELECT COUNT(*)::int AS n FROM ${OBJECTS} o LEFT JOIN ${REVIEWS} r ON r.object_id = o.id
        WHERE ${where.join(' AND ')}`,
      params
    );
    matched = recount[0].n;
  }
  return {
    rows,
    counts,
    all,
    matched,
    sessionId: countResult.rows.length ? countResult.rows[0].session_id : null,
  };
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
async function listContextObjects(connectionId, query = {}) {
  let result;
  try {
    result = await pageObjects(connectionId, { ...query, status: undefined }, 25);
  } catch (err) {
    asMissingStore(err);
  }
  /*
   * One page of a run's facts, with the per-type counts of the whole run for
   * the filter chips. Each object carries what its card renders - name, type,
   * source, the trust flag and the payload - and nothing else: the ids of the
   * session, the reviewer and the timestamps are not shown anywhere.
   */
  return {
    resolvedSessionId: result.sessionId,
    count: result.all,
    counts: result.counts,
    matched: result.matched,
    objects: result.rows.map((row) => ({
      id: row.id,
      objectType: row.object_type,
      qualifiedName: row.qualified_name,
      sourceType: row.source_type,
      verified: row.verified,
      payload: row.payload,
    })),
  };
}

/* ------------------------------------------------------------------ model --- */

/**
 * Splits a `column_stats` name (`<table>.<column>`) into its table and column.
 *
 * The table is the LONGEST known `table` row name the qualified name starts
 * with, not "everything before the last dot": column names can contain dots
 * themselves - flattened JSON fields like `data.documentationUploads.data.url`
 * - and cutting at the last dot turned every nesting level into a table of its
 * own. The last dot is only the fallback, for a column whose table the run
 * wrote no `table` row for.
 *
 * Returns a function so the table names are sorted once per read, not per row.
 */
function columnSplitter(rows) {
  const tables = rows
    .filter((row) => row.object_type === 'table')
    .map((row) => row.qualified_name)
    .sort((a, b) => b.length - a.length);

  return (qualifiedName) => {
    const name = String(qualifiedName || '');
    const table = tables.find((t) => name.startsWith(`${t}.`) && name.length > t.length + 1);
    if (table) return { table, column: name.slice(table.length + 1) };
    const index = name.lastIndexOf('.');
    return index === -1
      ? { table: null, column: name }
      : { table: name.slice(0, index), column: name.slice(index + 1) };
  };
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

  const split = columnSplitter(rows);
  const columnsByTable = new Map();
  for (const row of rows) {
    if (row.object_type !== 'column_stats') continue;
    const { table, column } = split(row.qualified_name);
    if (!table) continue;
    if (!columnsByTable.has(table)) columnsByTable.set(table, []);
    const payload = row.payload || {};
    columnsByTable.get(table).push({
      name: column,
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
    // Everything else the agent recorded, for the type-specific editor.
    fields: payload,
  };
}

/**
 * One page of the review queue, filtered in SQL.
 *
 * Counts are of EVERYTHING, not of the filtered set: they drive the filter
 * chips, and a chip whose number changes when you press it cannot be used to
 * decide what to press. `total` is that whole-run count; `matched` is how many
 * the current filters select, which is what the pager pages through.
 */
async function reviewQueue(connectionId, query = {}) {
  let result;
  try {
    result = await pageObjects(connectionId, query, 25);
  } catch (err) {
    asMissingStore(err);
  }
  return {
    items: result.rows.map(shapeReviewItem),
    counts: result.counts,
    total: result.all,
    matched: result.matched,
  };
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

  // The one row decided, not the whole run reloaded to find it.
  const updated = await loadObject(connectionId, objectId);
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
  const existing = await requireObject(connectionId, objectId);

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

  /*
   * Remembered as a human override. The review row keeps whatever decision
   * the item already had - an edit is not an approval - and `edited` is what
   * Understand shows as "Human override" and what stops a demo re-run from
   * overwriting the edit.
   */
  // `verified` is unchanged by a payload edit, so the row read by the first
  // requireObject above is still current for it - no second read.
  await db.query(
    `INSERT INTO ${REVIEWS}
       (object_id, connection_id, status, edited, reviewed_by, reviewed_at)
     VALUES (?::uuid, ?::uuid, ?, TRUE, ?, now())
     ON CONFLICT (object_id) DO UPDATE SET edited = TRUE`,
    [objectId, connectionId, existing.verified ? 'approved' : 'pending', actor.id]
  );

  const updated = await loadObject(connectionId, objectId);
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

  /*
   * The matching set is selected in SQL, and the decision is written for all
   * of it in one transaction of two set-based statements. This used to decide
   * one row at a time - each a lookup, a transaction and a reload of the whole
   * run - which was O(N) round trips and O(N^2) rows for "approve all".
   */
  const run = runClause(connectionId);
  const where = [run.sql];
  const params = [...run.params];
  if (filter.type) {
    where.push('o.object_type = ?');
    params.push(String(filter.type));
  }
  if (filter.status) {
    where.push(`${STATUS_SQL} = ?`);
    params.push(String(filter.status));
  }
  if (filter.minConfidence !== undefined && filter.minConfidence !== null) {
    // A row with no confidence has not met the bar; it has no bar. Excluded
    // rather than treated as zero or as passing.
    where.push('o.confidence IS NOT NULL AND o.confidence >= ?');
    params.push(Number(filter.minConfidence));
  }

  let ids;
  try {
    const { rows } = await db.query(
      `SELECT o.id FROM ${OBJECTS} o LEFT JOIN ${REVIEWS} r ON r.object_id = o.id
        WHERE ${where.join(' AND ')}`,
      params
    );
    ids = rows.map((r) => r.id);
  } catch (err) {
    asMissingStore(err);
  }
  if (!ids.length) return { affected: 0 };

  const status = STATUS_FOR[decision];
  await withTransaction(async (conn) => {
    await conn.query(
      `INSERT INTO ${REVIEWS} (object_id, connection_id, status, reviewed_by, reviewed_at)
       SELECT id, ?::uuid, ?, ?, now() FROM unnest(?::uuid[]) AS id
       ON CONFLICT (object_id) DO UPDATE SET
         status = EXCLUDED.status,
         reviewed_by = EXCLUDED.reviewed_by,
         reviewed_at = EXCLUDED.reviewed_at`,
      [connectionId, status, actor.id, ids]
    );
    // `skip` leaves `verified` alone - see decideReviewItem.
    if (decision !== 'skip') {
      await conn.query(
        `UPDATE ${OBJECTS}
            SET verified = ?, reviewed_by = ?, reviewed_at = now(), updated_at = now()
          WHERE id = ANY(?::uuid[]) AND workspace_id = ?::uuid`,
        [decision === 'approve', actor.username, ids, connectionId]
      );
    }
  });
  return { affected: ids.length };
}

/* ------------------------------------------------------------- understand --- */

/*
 * What a row is called in the business glossary.
 *
 * `table` rows are the entities, `metric` rows the metrics. A `glossary` row
 * is a Dimension when the run said it describes one (`payload.kind`), and a
 * plain business Term otherwise - the skill's glossary covers both.
 */
const TERM_TYPES = {
  table: 'entity',
  metric: 'metric',
  glossary: 'term',
};

const TYPE_LABELS = { entity: 'Entity', metric: 'Metric', dimension: 'Dimension', term: 'Term' };

/** `sales_orders_total_amount` → `Sales orders total amount`. */
function readable(value) {
  const text = String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * Where a term stands, in the words the glossary uses.
 *
 *   human_override  - a person edited what the run wrote
 *   human_approved  - a person approved it
 *   source_verified - verified by the run itself (structural facts read from
 *                     the source), no person involved yet
 *   ai_generated    - pending, and the run was confident (>= 0.8)
 *   ai_suggested    - pending, low or unknown confidence: needs review first
 *   rejected
 */
const CONFIDENT = 0.8;

/*
 * The glossary's filter chips, by id. "review" is the low-confidence pending
 * set - the confident ones are "ai" - and "approved" counts the run's own
 * verified structural facts alongside a person's approvals.
 */
const GLOSSARY_FILTERS = {
  all: null,
  ai: ['ai_generated'],
  review: ['ai_suggested'],
  approved: ['human_approved', 'source_verified'],
  override: ['human_override'],
};

function termState(row) {
  const status = reviewStatusOf(row);
  if (status === 'rejected') return 'rejected';
  if (row.review_edited) return 'human_override';
  if (status === 'approved') return row.review_status === 'approved' ? 'human_approved' : 'source_verified';
  const confidence = row.confidence === null ? null : Number(row.confidence);
  return confidence !== null && confidence >= CONFIDENT ? 'ai_generated' : 'ai_suggested';
}

function appliesTo(row) {
  const payload = row.payload || {};
  if (typeof payload.applies_to === 'string') return payload.applies_to;
  if (Array.isArray(payload.applies_to)) return payload.applies_to.join(', ');
  if (row.object_type === 'table') return row.qualified_name;
  if (typeof payload.underlying_table === 'string') return payload.underlying_table;
  return null;
}

/**
 * The Understand step: the business glossary the latest run produced, with
 * the counts above it.
 *
 * Built here from `context_objects` rather than in the browser, for the same
 * reason as the publish summary - every number on the screen is the backend's.
 * Columns are left out of the glossary on purpose: they are schema, one row
 * per field, and they are reviewed in Review; the glossary is the vocabulary.
 */
async function understanding(connectionId, query = {}) {
  let rows;
  try {
    // Only the three glossary types - never the column_stats bulk of a run.
    rows = await loadObjects(connectionId, undefined, { types: Object.keys(TERM_TYPES) });
  } catch (err) {
    asMissingStore(err);
  }

  const terms = rows
    .filter((row) => TERM_TYPES[row.object_type])
    .map((row) => {
      const payload = row.payload || {};
      const type =
        row.object_type === 'glossary' && payload.kind === 'dimension'
          ? 'dimension'
          : TERM_TYPES[row.object_type];
      return {
        id: row.id,
        term: typeof payload.term === 'string' && payload.term ? payload.term : readable(row.qualified_name),
        type,
        typeLabel: TYPE_LABELS[type],
        definition:
          (typeof payload.description === 'string' && payload.description) ||
          (typeof payload.definition === 'string' && payload.definition) ||
          null,
        appliesTo: appliesTo(row),
        confidence: row.confidence === null ? null : Number(row.confidence),
        state: termState(row),
        objectType: row.object_type,
        qualifiedName: row.qualified_name,
        reviewedAt: row.review_reviewed_at || row.reviewed_at || null,
      };
    });

  // Entities first, then metrics, dimensions and terms - the order a reader
  // builds the vocabulary in - and alphabetical within each.
  const order = { entity: 0, metric: 1, dimension: 2, term: 3 };
  terms.sort((a, b) => order[a.type] - order[b.type] || a.term.localeCompare(b.term));

  const scored = terms.filter((t) => t.confidence !== null);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const human = terms.filter((t) => t.state === 'human_approved' || t.state === 'human_override');

  /*
   * The stats describe the whole glossary; the terms list is one filtered
   * page of it. The chips and search used to filter and page every term in
   * the browser - here only the visible page is sent, with `matched` for the
   * pager.
   */
  const filter = query.filter ? String(query.filter) : 'all';
  if (!Object.prototype.hasOwnProperty.call(GLOSSARY_FILTERS, filter)) {
    throw fail('VALIDATION_ERROR', `filter must be one of: ${Object.keys(GLOSSARY_FILTERS).join(', ')}.`);
  }
  const states = GLOSSARY_FILTERS[filter];
  const needle = String(query.search || '').trim().toLowerCase();
  const selected = terms.filter((t) => {
    if (states && !states.includes(t.state)) return false;
    if (!needle) return true;
    return (
      t.term.toLowerCase().includes(needle) ||
      (t.definition || '').toLowerCase().includes(needle) ||
      (t.appliesTo || '').toLowerCase().includes(needle)
    );
  });
  const paging = pageOf(query, 10);

  return {
    matched: selected.length,
    stats: {
      termsGenerated: terms.length,
      entityCount: terms.filter((t) => t.type === 'entity').length,
      metricCount: terms.filter((t) => t.type === 'metric').length,
      dimensionCount: terms.filter((t) => t.type === 'dimension' || t.type === 'term').length,
      averageConfidence: scored.length
        ? scored.reduce((sum, t) => sum + t.confidence, 0) / scored.length
        : null,
      humanApproved: human.length,
      approvedThisWeek: human.filter((t) => t.reviewedAt && new Date(t.reviewedAt).getTime() >= weekAgo).length,
    },
    // Each term carries what its row renders: the chip label is `typeLabel`,
    // and `type`, `objectType`, `qualifiedName` and `reviewedAt` stay here.
    terms: selected.slice(paging.offset, paging.offset + paging.pageSize).map((t) => ({
      id: t.id,
      term: t.term,
      typeLabel: t.typeLabel,
      definition: t.definition,
      appliesTo: t.appliesTo,
      confidence: t.confidence,
      state: t.state,
    })),
  };
}

module.exports = {
  loadObjects,
  loadObject,
  columnSplitter,
  understanding,
  listContextObjects,
  modelGraph,
  reviewQueue,
  decideReviewItem,
  updateReviewItem,
  bulkDecide,
  shapeReviewItem,
  reviewStatusOf,
};
