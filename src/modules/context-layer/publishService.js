const { withTransaction } = require('../../config/database');
const { fail, requireString } = require('../../api/response');
const { loadObjects, reviewStatusOf } = require('./contextStore');
const versions = require('./versionService');

/**
 * Publishing a context: giving a reviewed set of facts a name and a version.
 *
 * What "publish" means here is deliberately narrow and honest. It does not
 * push anything to another system. It records that, at this moment, this named
 * context consisted of exactly these approved facts - a snapshot, with the
 * counts that describe it, owned by one connection and one company.
 *
 * The NAME is the point of the step. A connection is "Domo - Sales"; a
 * published context is "Revenue", "Site safety", "Q3 cost model" - what the
 * thing is FOR, which is not the same as where its data came from, and which
 * one connection can produce several of.
 *
 * The snapshot is stored rather than referenced. A published context that was
 * only a list of ids would change underneath whoever is reading it the next
 * time somebody edits a description - which is the one thing a version is
 * supposed to prevent.
 *
 * Where it is stored: `context_layer_versions` (see versionService.js). The
 * version being built is a `draft` row; publishing flips that same row to
 * `published`, and the next edit opens a new draft for version n+1.
 */

/** Only approved facts are published. Everything else is still somebody's decision. */
function publishable(rows) {
  return rows.filter((row) => reviewStatusOf(row) === 'approved');
}

function countByType(rows) {
  const counts = {};
  for (const row of rows) {
    counts[row.object_type] = (counts[row.object_type] || 0) + 1;
  }
  return counts;
}

/**
 * The tables a set of facts covers.
 *
 * Derived from `table` rows where there are any, and from the prefix of
 * `column_stats` names otherwise - a run can record columns for a table it did
 * not write a `table` row for, and the count should say what is actually
 * covered rather than what happens to have one row type.
 */
function tablesCovered(rows) {
  const names = new Set();
  for (const row of rows) {
    if (row.object_type === 'table') names.add(row.qualified_name);
    else if (row.object_type === 'column_stats') {
      const dot = row.qualified_name.lastIndexOf('.');
      if (dot > 0) names.add(row.qualified_name.slice(0, dot));
    }
  }
  return [...names];
}

/**
 * What publishing would include, and what is stopping it.
 *
 * Every number is counted here, from the rows themselves, rather than being
 * sent up by the screen - the whole point of the step is to state what is
 * about to become visible, and a count derived from client state describes the
 * browser's idea of the context rather than the one being published.
 */
async function publishSummary(actor, connection) {
  const rows = await loadObjects(connection.id);
  const approved = publishable(rows);
  const pending = rows.filter((row) => reviewStatusOf(row) === 'pending');
  const counts = countByType(approved);
  const tables = tablesCovered(approved);

  const stats = [
    { id: 'datasets', label: 'Datasets', value: (connection.selectedDatasets || []).length },
    { id: 'tables', label: 'Tables', value: tables.length },
    { id: 'columns', label: 'Columns', value: counts.column_stats || 0 },
    { id: 'joins', label: 'Relationships', value: counts.join || 0 },
    { id: 'transformations', label: 'Transformations', value: counts.transformation || 0 },
    { id: 'metrics', label: 'Metrics', value: counts.metric || 0 },
    { id: 'glossary', label: 'Glossary terms', value: counts.glossary || 0 },
    { id: 'examples', label: 'Examples', value: counts.example || 0 },
  ];

  const blockers = [];
  if (approved.length === 0) {
    blockers.push({
      id: 'nothing-approved',
      severity: 'blocker',
      message:
        rows.length === 0
          ? 'No extraction has run for this connection yet.'
          : 'Nothing has been approved yet. Approve at least one item before publishing.',
      step: rows.length === 0 ? 'understand' : 'review',
    });
  }
  if (pending.length > 0) {
    blockers.push({
      id: 'pending-review',
      severity: 'warning',
      message: `${pending.length} item${pending.length === 1 ? '' : 's'} still awaiting review. ${
        pending.length === 1 ? 'It' : 'They'
      } will not be published.`,
      step: 'review',
    });
  }

  const [previous, draft] = await Promise.all([
    versions.latestPublished(connection.id),
    versions.currentDraft(connection.id),
  ]);

  return {
    connectionId: connection.id,
    // The draft's name, then the last published one, then the connection's -
    // a starting point, not the answer. See `publishContext`.
    suggestedName: draft ? draft.name : previous ? previous.name : connection.name,
    previousVersion: previous ? previous.version : null,
    draft,
    stats,
    datasets: (connection.selectedDatasets || []).map((dataset) => ({
      id: dataset.id,
      name: dataset.name || dataset.id,
      tableCount: null,
    })),
    content: [
      { id: 'tables', label: 'Table descriptions', included: (counts.table || 0) > 0 },
      { id: 'columns', label: 'Column statistics and descriptions', included: (counts.column_stats || 0) > 0 },
      { id: 'joins', label: 'Table relationships', included: (counts.join || 0) > 0 },
      { id: 'transformations', label: 'Lineage and transformations', included: (counts.transformation || 0) > 0 },
      { id: 'metrics', label: 'Metrics', included: (counts.metric || 0) > 0 },
      { id: 'glossary', label: 'Glossary terms', included: (counts.glossary || 0) > 0 },
      { id: 'examples', label: 'Example queries and cards', included: (counts.example || 0) > 0 },
    ],
    ready: approved.length > 0,
    blockers,
  };
}

/** Pre-flight, separately callable so nothing publishes into a failed check. */
async function validatePublish(actor, connection) {
  const summary = await publishSummary(actor, connection);
  return {
    valid: summary.blockers.every((blocker) => blocker.severity !== 'blocker'),
    blockers: summary.blockers.filter((b) => b.severity === 'blocker'),
    warnings: summary.blockers.filter((b) => b.severity !== 'blocker'),
  };
}

/** Every PUBLISHED version under one connection, newest first. */
async function listPublications(connectionId) {
  const state = await versions.versionState({ id: connectionId });
  return state.versions
    .filter((v) => v.status === 'published')
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .map((v) => ({
      id: v.id,
      name: v.name,
      version: v.version,
      sessionId: v.sessionId,
      objectCount: v.objectCount,
      stats: v.stats,
      publishedBy: v.publishedBy,
      publishedAt: v.publishedAt,
    }));
}

/**
 * Publishes the open draft.
 *
 * The version is per NAME, not per connection: republishing "Revenue" makes
 * v2 of Revenue, and publishing "Site safety" from the same connection starts
 * at v1. That is what somebody means by a version - the history of this named
 * thing, not of the credential it happened to come from.
 *
 * Computed inside the transaction, with the draft row locked, so two people
 * publishing at once cannot both read v1 and both write v2; the unique index
 * on (connection_id, name, version) is what finally enforces it.
 */
async function publishContext(actor, connection, { name, notifyTeam = false } = {}) {
  const cleanName = requireString(name, 'Context name', { min: 2, max: 120 });

  const rows = await loadObjects(connection.id);
  const approved = publishable(rows);
  if (approved.length === 0) {
    throw fail(
      'VALIDATION_ERROR',
      'There is nothing approved to publish. Approve at least one item in Review first.'
    );
  }

  const counts = countByType(approved);
  /*
   * The facts themselves, as they were at this moment. Stored rather than
   * referenced: a published version that pointed at live rows would change
   * whenever somebody edited a description, which is precisely what a version
   * exists to prevent.
   */
  const snapshot = approved.map((row) => ({
    id: row.id,
    objectType: row.object_type,
    qualifiedName: row.qualified_name,
    sourceType: row.source_type,
    confidence: row.confidence === null ? null : Number(row.confidence),
    payload: row.payload,
  }));

  const published = await withTransaction((conn) =>
    versions.publishDraft(conn, actor, connection, {
      name: cleanName,
      snapshot,
      stats: { counts, tables: tablesCovered(approved) },
      sessionId: approved[0].session_id || null,
      notifyTeam,
    })
  );

  return {
    id: published.id,
    name: published.name,
    version: published.label,
    publishedAt: published.publishedAt,
    objectCount: published.objectCount,
    status: 'published',
  };
}

module.exports = {
  publishSummary,
  validatePublish,
  publishContext,
  listPublications,
};
