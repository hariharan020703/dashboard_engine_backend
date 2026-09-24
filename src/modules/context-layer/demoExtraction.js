const crypto = require('crypto');
const { withTransaction } = require('../../config/database');
const { quoteIdentifier } = require('../../config/pgPool');
const { fail } = require('../../api/response');
const connections = require('./connectionService');
const versions = require('./versionService');

/**
 * DEMO extraction: what the context_layer_extractor agent would write, built
 * without calling a model.
 *
 * TEMPORARY. It exists because the Anthropic credit behind the real agent is
 * exhausted, and the workflow after step 4 has nothing to show without facts.
 * Switched on by CONTEXT_EXTRACTION_MODE=demo (see extractionMode.js); set it
 * back to `agent` and the builder calls the real agent again - nothing else
 * changes, and this file can be deleted.
 *
 * What it is and is not:
 *
 *   It IS driven by the real selection. Every selected dataset is profiled
 *   live from the warehouse - the same call Profile makes - so table names,
 *   columns, types, null rates, distinct counts and sample values are the
 *   source's own. Two tables selected means two tables of facts; forty
 *   columns means forty column rows.
 *
 *   It is NOT an interpretation. Descriptions, metrics, glossary terms and
 *   example queries are generated from templates over those facts, and joins
 *   are guessed from matching column names. So everything interpretive is
 *   written `verified = false`, `source_type = 'db_inferred'` - pending human
 *   review, exactly as the skill requires of the agent.
 *
 *   The screen presents it like any extraction run (product decision). Where
 *   it came from is recorded server-side instead: `extraction_mode = 'demo'`
 *   on the version row, and `mode: 'demo'` on the audit event.
 *
 * It writes the SAME rows the agent does - `context_objects`, tagged with a
 * session id, payloads shaped per the skill's `payload-schemas.md` - which is
 * what makes Understand, Model, Review and Publish work unchanged downstream.
 */

const OBJECTS = quoteIdentifier('context_objects');

/** Enough to demo; a selection larger than this is profiled up to the cap. */
const MAX_TABLES = 25;
const MAX_COLUMNS_PER_TABLE = 150;
const MAX_METRIC_COLUMNS = 3;
const PROFILE_CONCURRENCY = 3;

/* ---------------------------------------------------------------- names --- */

/** `Sales Orders (2024)` → `sales_orders_2024`. Stable and human-legible, per the skill. */
function slug(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

/** `customer_id` → `customer id`. */
function humanize(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** `sales order` → `Sales order`. The glossary's display name. */
function title(words) {
  const text = String(words || '').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** A rough singular for prose - "orders" reads as "each order". */
function singular(words) {
  if (/ies$/.test(words)) return words.replace(/ies$/, 'y');
  if (/sses$/.test(words)) return words.replace(/es$/, '');
  if (/s$/.test(words) && !/ss$/.test(words)) return words.replace(/s$/, '');
  return words;
}

/* ---------------------------------------------------------- column kinds --- */

const ID_NAME = /(^id$|_id$|id$|_key$|^key$|_code$|^code$|_no$|_number$)/i;

/** What a column is for, from its source type and name. Presentation only. */
function kindOf(column) {
  const type = String(column.dataType || '').toLowerCase();
  const name = String(column.name || '');
  if (/bool/.test(type)) return 'bool';
  if (/date|time/.test(type) || /(date|_at$|_on$|timestamp|time$)/i.test(name)) return 'date';
  if (ID_NAME.test(name)) return 'id';
  if (/long|int|double|decimal|float|number|numeric|real/.test(type)) return 'number';
  return 'text';
}

function formatCount(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return Number(value).toLocaleString('en-US');
}

function percent(value) {
  if (value === null || value === undefined) return 'unknown';
  const rounded = Math.round(Number(value) * 10) / 10;
  return `${rounded}%`;
}

/** Distinct non-null values of one column in the displayed sample rows. */
function sampleValues(profile, columnName, limit = 8) {
  const sample = profile && profile.sample;
  if (!sample || !Array.isArray(sample.columns)) return [];
  const index = sample.columns.indexOf(columnName);
  if (index === -1) return [];
  const seen = new Set();
  for (const row of sample.rows || []) {
    const value = row[index];
    if (value === null || value === undefined || value === '') continue;
    seen.add(String(value));
    if (seen.size >= limit) break;
  }
  return [...seen];
}

/* ------------------------------------------------------------- profiling --- */

/** Runs `fn` over `items`, at most `limit` at a time. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Profiles every selected dataset, live. A dataset whose profile fails is kept
 * with what the selection stored (name and counts) and its error, so one
 * unreachable dataset does not sink the run - and the report says which.
 */
async function profileSelection(actor, connection) {
  const selected = (connection.selectedDatasets || []).slice(0, MAX_TABLES);
  return mapLimit(selected, PROFILE_CONCURRENCY, async (dataset) => {
    try {
      const profile = await connections.tableProfile(actor, connection.id, dataset.id);
      return { dataset, profile, error: null };
    } catch (err) {
      return { dataset, profile: null, error: err.message || String(err) };
    }
  });
}

/* ------------------------------------------------------------ generation --- */

/**
 * One table's worth of context, derived from its profile.
 *
 * `name` is the qualified name every other row refers to it by.
 */
function describeTable(entry, name) {
  const { dataset, profile } = entry;
  const columns = ((profile && profile.columns) || []).slice(0, MAX_COLUMNS_PER_TABLE);
  const sampleSize = profile ? profile.statsSampleSize : null;
  const rowCount = profile && profile.rowCount !== null ? profile.rowCount : dataset.rowCount;
  const entity = singular(humanize(name)) || 'record';

  const enriched = columns.map((column) => {
    const kind = kindOf(column);
    const unique =
      sampleSize > 0 && column.uniqueCount === sampleSize && Number(column.nullPercent) === 0;
    return { ...column, kind, unique, values: sampleValues(profile, column.name) };
  });

  const primaryKey =
    enriched.find((c) => c.unique && c.kind === 'id') ||
    enriched.find((c) => c.unique && /^id$/i.test(c.name)) ||
    null;

  return {
    name,
    title: (profile && profile.name) || dataset.name || dataset.id,
    entity,
    rowCount,
    sampleSize,
    lastRefreshedAt: profile ? profile.lastRefreshedAt : null,
    columns: enriched,
    primaryKey,
    profiled: Boolean(profile),
    error: entry.error,
  };
}

function columnDescription(table, column) {
  const human = humanize(column.name);
  switch (column.kind) {
    case 'id':
      return column === table.primaryKey
        ? `Unique identifier for each ${table.entity}.`
        : `Identifier referencing the related ${singular(human.replace(/\s*(id|key|code|no|number)$/, '')) || 'record'}.`;
    case 'date':
      return `Date/time value recording "${human}" for each ${table.entity}.`;
    case 'number': {
      const range =
        column.min !== null && column.min !== undefined && column.max !== null && column.max !== undefined
          ? ` Ranges from ${column.min} to ${column.max} in the sample.`
          : '';
      return `Numeric measure "${human}" on each ${table.entity}.${range}`;
    }
    case 'bool':
      return `Yes/no flag indicating "${human}".`;
    default:
      if (column.uniqueCount !== null && column.uniqueCount <= 12 && column.values.length) {
        return `Category of ${human}, e.g. ${column.values.slice(0, 4).join(', ')}.`;
      }
      return `Descriptive text field "${human}" for each ${table.entity}.`;
  }
}

function tableDescription(table) {
  const measures = table.columns.filter((c) => c.kind === 'number').map((c) => c.name);
  const dates = table.columns.filter((c) => c.kind === 'date').map((c) => c.name);
  const dims = table.columns.filter((c) => c.kind === 'text').map((c) => c.name);
  const parts = [
    `${table.title}: one row per ${table.entity}` +
      (table.rowCount !== null && table.rowCount !== undefined ? ` (≈ ${formatCount(table.rowCount)} rows)` : '') +
      `, ${table.columns.length} column${table.columns.length === 1 ? '' : 's'}.`,
  ];
  if (measures.length) parts.push(`Measures: ${measures.slice(0, 5).join(', ')}.`);
  if (dims.length) parts.push(`Attributes: ${dims.slice(0, 5).join(', ')}.`);
  if (dates.length) parts.push(`Dated by ${dates.slice(0, 3).join(', ')}.`);
  return parts.join(' ');
}

/**
 * Joins guessed between every pair of tables, from identically named key
 * columns - `orders.customer_id` ↔ `customers.customer_id` - or from one
 * table's `<entity>_id` matching another's primary key.
 *
 * Name matching is a guess, not a constraint, so every join is unverified with
 * a confidence below 1.00 and its basis stated.
 */
function inferJoins(tables) {
  const joins = [];
  for (let i = 0; i < tables.length; i += 1) {
    for (let j = i + 1; j < tables.length; j += 1) {
      const a = tables[i];
      const b = tables[j];
      const match = bestKey(a, b) || swap(bestKey(b, a));
      if (!match) continue;

      const { leftCol, rightCol, confidence, basis } = match;
      const cardinality =
        leftCol.unique && !rightCol.unique
          ? '1:many'
          : rightCol.unique && !leftCol.unique
            ? 'many:1'
            : leftCol.unique && rightCol.unique
              ? '1:1'
              : 'many:many';

      joins.push({
        left: a,
        right: b,
        leftColumn: leftCol.name,
        rightColumn: rightCol.name,
        cardinality,
        confidence,
        basis,
      });
    }
  }
  return joins;

  function swap(found) {
    return found
      ? { ...found, leftCol: found.rightCol, rightCol: found.leftCol }
      : null;
  }
}

/** The strongest key from `a` to `b`, or null. */
function bestKey(a, b) {
  // `a.<entity_b>_id` referencing b's primary key.
  if (b.primaryKey) {
    const wanted = `${slug(b.entity)}_id`;
    const fk = a.columns.find((c) => slug(c.name) === wanted);
    if (fk) {
      return {
        leftCol: fk,
        rightCol: b.primaryKey,
        confidence: 0.85,
        basis: `${a.name}.${fk.name} is named after ${b.name} and ${b.name}.${b.primaryKey.name} is unique and non-null in the sample.`,
      };
    }
  }
  // Identically named key-like columns.
  for (const col of a.columns) {
    if (col.kind !== 'id') continue;
    const other = b.columns.find((c) => c.kind === 'id' && slug(c.name) === slug(col.name));
    if (other) {
      return {
        leftCol: col,
        rightCol: other,
        confidence: col.unique || other.unique ? 0.8 : 0.6,
        basis: `Both tables have a key-like column named "${col.name}"` +
          (col.unique || other.unique ? ', unique on one side in the sample.' : '; neither side is unique in the sample.'),
      };
    }
  }
  return null;
}

/** Every `context_objects` row the run writes, in payload-schemas.md shape. */
function buildObjects(tables, joins) {
  const objects = [];
  const push = (objectType, qualifiedName, payload, { verified = false, sourceType = 'db_inferred', confidence = null } = {}) => {
    objects.push({
      id: crypto.randomUUID(),
      object_type: objectType,
      qualified_name: qualifiedName,
      source_type: sourceType,
      verified,
      confidence,
      payload,
    });
  };

  for (const table of tables) {
    const foreignKeys = joins
      .filter((j) => j.left === table || j.right === table)
      .map((j) =>
        j.left === table
          ? { column: j.leftColumn, references: `${j.right.name}.${j.rightColumn}` }
          : { column: j.rightColumn, references: `${j.left.name}.${j.leftColumn}` }
      );

    // Structural facts read from the source: verified, BI-sourced.
    push(
      'table',
      table.name,
      {
        columns: table.columns.map((c) => ({ name: c.name, type: c.dataType })),
        primary_key: table.primaryKey
          ? `${table.primaryKey.name} (candidate: unique and non-null in a ${formatCount(table.sampleSize)}-row sample)`
          : table.profiled
            ? 'none detected in the sample'
            : 'unknown - the table could not be profiled',
        ...(foreignKeys.length ? { foreign_keys: foreignKeys } : {}),
        ...(table.rowCount !== null && table.rowCount !== undefined ? { row_count: `≈ ${formatCount(table.rowCount)}` } : {}),
        ...(table.lastRefreshedAt ? { freshness: `last refreshed ${table.lastRefreshedAt}` } : {}),
        description: tableDescription(table),
        term: title(table.entity),
      },
      // Read straight from the source: as certain as this run gets.
      { verified: table.profiled, sourceType: 'bi_verified', confidence: table.profiled ? 0.95 : 0.4 }
    );

    // Nothing was read for an unprofiled table, so nothing is derived from it.
    if (!table.profiled) continue;

    for (const column of table.columns) {
      const notes = [];
      if (column === table.primaryKey) notes.push('candidate primary key');
      if (Number(column.nullPercent) >= 50) notes.push('mostly null in the sample');
      if (table.sampleSize) notes.push(`statistics from a ${formatCount(table.sampleSize)}-row sample, not a full scan`);

      push(
        'column_stats',
        `${table.name}.${column.name}`,
        {
          data_type: column.dataType,
          null_rate: percent(column.nullPercent),
          ...(column.uniqueCount !== null && column.uniqueCount !== undefined
            ? column.uniqueCount <= 12 && column.values.length
              ? { distinct_values: column.values.join(', ') }
              : { distinct_count_est: `${formatCount(column.uniqueCount)} in sample` }
            : {}),
          ...(column.min !== null && column.min !== undefined ? { min: column.min } : {}),
          ...(column.max !== null && column.max !== undefined ? { max: column.max } : {}),
          ...(notes.length ? { note: notes.join('; ') } : {}),
          description: columnDescription(table, column),
        },
        { verified: true, sourceType: 'bi_verified' }
      );
    }

    // Metrics: a count, and totals over the first few numeric measures.
    push(
      'metric',
      `${table.name}_count`,
      {
        term: title(`${table.entity} count`),
        formula: `COUNT(*) FROM ${table.name}`,
        underlying_table: table.name,
        synonyms: `number of ${humanize(table.name)}, ${table.entity} count`,
        owner: 'unassigned',
        description: `Number of ${humanize(table.name)} records.`,
      },
      // A row count needs no interpretation.
      { confidence: 0.97 }
    );
    const measures = table.columns.filter((c) => c.kind === 'number').slice(0, MAX_METRIC_COLUMNS);
    for (const measure of measures) {
      push(
        'metric',
        `${table.name}_total_${slug(measure.name)}`,
        {
          term: title(`total ${humanize(measure.name)}`),
          formula: `SUM(${table.name}.${measure.name})`,
          underlying_table: table.name,
          synonyms: `total ${humanize(measure.name)}, sum of ${humanize(measure.name)}`,
          owner: 'unassigned',
          description: `Sum of ${humanize(measure.name)} across all ${humanize(table.name)}.`,
        },
        /*
         * Summing is right for amounts and quantities, wrong for rates and
         * prices-per-unit; the name is the only evidence, so a measure that
         * reads like an amount scores higher than one that does not.
         */
        {
          confidence: /(amount|revenue|sales|total|cost|qty|quantity|units|value|price)/i.test(measure.name)
            ? 0.88
            : 0.72,
        }
      );
    }

    // Glossary: low-cardinality text columns, whose values need defining.
    const categories = table.columns.filter(
      (c) => c.kind === 'text' && c.uniqueCount !== null && c.uniqueCount >= 2 && c.uniqueCount <= 12 && c.values.length
    );
    for (const category of categories.slice(0, 3)) {
      const definition = `The ${humanize(category.name)} of a ${table.entity}; one of ${category.values.join(', ')}.`;
      push(
        'glossary',
        `${humanize(category.name)} (${table.name})`,
        {
          term: title(humanize(category.name)),
          kind: 'dimension',
          applies_to: table.name,
          definition,
          description: definition,
          synonyms: humanize(category.name),
          owner: 'unassigned',
          note: 'Values taken from the sample - confirm the full list and what each means.',
        },
        // Every value seen is listed when there are few; more values, less certainty.
        { confidence: category.uniqueCount <= 5 ? 0.86 : 0.74 }
      );
    }

    // Example: an aggregate over the first category and measure, else a preview.
    const dim = categories[0] || table.columns.find((c) => c.kind === 'text');
    const measure = measures[0];
    const date = table.columns.find((c) => c.kind === 'date');
    push('example', `${table.name}__example`, {
      reads_from: [table.name],
      sql_template:
        dim && measure
          ? `SELECT ${dim.name}, SUM(${measure.name}) AS total_${slug(measure.name)} FROM ${table.name} GROUP BY ${dim.name} ORDER BY 2 DESC LIMIT 10`
          : `SELECT * FROM ${table.name} LIMIT 100`,
      used_in_dashboards: 'none yet - generated example',
      usage_count_30d: 0,
      ...(date ? { common_filters: `${date.name} range` } : {}),
      description:
        dim && measure
          ? `Top ${humanize(dim.name)} values by total ${humanize(measure.name)}.`
          : `A first look at ${humanize(table.name)}.`,
    });
  }

  for (const join of joins) {
    push(
      'join',
      `${join.left.name}__${join.right.name}`,
      {
        tables: [join.left.name, join.right.name],
        join_keys: [{ left: join.leftColumn, right: join.rightColumn }],
        cardinality: join.cardinality,
        confidence: join.confidence,
        basis: join.basis,
      },
      { confidence: join.confidence }
    );
    push('example', `${join.left.name}__${join.right.name}__example`, {
      reads_from: [join.left.name, join.right.name],
      sql_template: `SELECT l.*, r.* FROM ${join.left.name} l JOIN ${join.right.name} r ON l.${join.leftColumn} = r.${join.rightColumn} LIMIT 100`,
      used_in_dashboards: 'none yet - generated example',
      usage_count_30d: 0,
      description: `${humanize(join.left.name)} joined to ${humanize(join.right.name)} on ${join.leftColumn}.`,
    });
  }

  return objects;
}

/** The run's own account, in markdown - rendered as the "Agent report". */
function buildReport(tables, joins, objects) {
  const counts = {};
  for (const o of objects) counts[o.object_type] = (counts[o.object_type] || 0) + 1;
  const failed = tables.filter((t) => !t.profiled);

  const lines = [
    '## Summary',
    '',
    `Profiled **${tables.length - failed.length} of ${tables.length}** selected table${tables.length === 1 ? '' : 's'} and wrote **${objects.length}** facts to the context layer.`,
    '',
    '| Fact type | Count |',
    '|---|---:|',
    ...Object.entries(counts).map(([type, n]) => `| ${type} | ${n} |`),
    '',
    '## Tables',
    '',
    '| Table | Rows | Columns | Candidate key |',
    '|---|---:|---:|---|',
    ...tables.map(
      (t) =>
        `| \`${t.name}\` | ${formatCount(t.rowCount) || '—'} | ${t.profiled ? t.columns.length : '—'} | ${t.primaryKey ? `\`${t.primaryKey.name}\`` : '—'} |`
    ),
    '',
    '## Relationships',
    '',
  ];

  if (joins.length) {
    for (const j of joins) {
      lines.push(
        `- \`${j.left.name}.${j.leftColumn}\` → \`${j.right.name}.${j.rightColumn}\` (${j.cardinality}, confidence ${j.confidence.toFixed(2)}) — ${j.basis}`
      );
    }
  } else {
    lines.push(
      tables.length > 1
        ? '- No shared key columns were found between the selected tables.'
        : '- Only one table is selected, so there is nothing to relate it to.'
    );
  }

  if (failed.length) {
    lines.push('', '## Not profiled', '');
    for (const t of failed) lines.push(`- \`${t.name}\` — ${t.error}`);
  }

  lines.push(
    '',
    '## Next steps',
    '',
    '1. **Model** — check the inferred relationships.',
    '2. **Review** — table and column facts are verified against the source; approve or edit the metrics, glossary terms, relationships and examples, starting with the lowest confidence.',
    '3. **Publish** — only approved facts are included.'
  );
  return lines.join('\n');
}

/* ---------------------------------------------------------------- write --- */

/**
 * Upserts the run's rows in ONE statement.
 *
 * One statement rather than one per row: the context store is a remote
 * database, and a few hundred round trips at a few hundred milliseconds each
 * is minutes of waiting for what is a single write.
 *
 * On conflict - the same qualified name from an earlier run - the payload and
 * session are replaced but a HUMAN decision is kept: a row somebody has
 * reviewed keeps its `verified`, and a row somebody EDITED keeps its payload,
 * so re-running the demo does not undo Review.
 *
 * Rows an earlier DEMO run wrote that this one did not are removed, so the
 * run fully replaces the previous demo instead of leaving orphans from a
 * deselected table. Rows the real agent wrote are never touched: a demo run's
 * session is recognised by the version rows that recorded it as
 * `extraction_mode = 'demo'` (and, for runs from before that, by the old
 * `demo-` session prefix).
 */
async function writeObjects(connectionId, sessionId, objects) {
  await withTransaction(async (conn) => {
    await conn.query(
      `DELETE FROM ${OBJECTS}
        WHERE workspace_id = ?::uuid
          AND (session_id LIKE 'demo-%'
               OR session_id IN (SELECT v.session_id FROM ${quoteIdentifier('context_layer_versions')} v
                                  WHERE v.connection_id = ?::uuid
                                    AND v.extraction_mode = 'demo'
                                    AND v.session_id IS NOT NULL))
          AND NOT (qualified_name = ANY(?::text[]))`,
      [connectionId, connectionId, objects.map((o) => o.qualified_name)]
    );

    await conn.query(
      `INSERT INTO ${OBJECTS}
         (id, workspace_id, session_id, object_type, qualified_name, source_type,
          verified, confidence, payload)
       SELECT r.id, ?::uuid, ?, r.object_type, r.qualified_name, r.source_type,
              r.verified, r.confidence, r.payload
         FROM jsonb_to_recordset(?::jsonb) AS r(
                id uuid, object_type text, qualified_name text, source_type text,
                verified boolean, confidence numeric, payload jsonb)
       ON CONFLICT (workspace_id, qualified_name) DO UPDATE SET
         session_id  = EXCLUDED.session_id,
         object_type = EXCLUDED.object_type,
         source_type = EXCLUDED.source_type,
         confidence  = EXCLUDED.confidence,
         payload     = CASE WHEN EXISTS (
                         SELECT 1 FROM ${quoteIdentifier('context_object_reviews')} rv
                          WHERE rv.object_id = ${OBJECTS}.id AND rv.edited)
                       THEN ${OBJECTS}.payload ELSE EXCLUDED.payload END,
         verified    = CASE WHEN ${OBJECTS}.reviewed_at IS NOT NULL
                            THEN ${OBJECTS}.verified ELSE EXCLUDED.verified END,
         updated_at  = now()`,
      [connectionId, sessionId, JSON.stringify(objects)]
    );
  });
}

/* ------------------------------------------------------------------ run --- */

/**
 * Runs the demo extraction for a connection's saved selection.
 *
 * Returns the same shape the ADK API's chat response is mapped to in the
 * browser (`ExtractionResult`), plus `mode: 'demo'` so the screen can say so.
 * `toolCalls` is empty: no tools were called, and inventing a list would be
 * faking the audit trail the field exists for.
 */
async function runDemoExtraction(actor, connection) {
  const selected = connection.selectedDatasets || [];
  if (selected.length === 0) {
    throw fail('VALIDATION_ERROR', 'Select at least one dataset in Discover before running the extraction.');
  }

  const entries = await profileSelection(actor, connection);

  const used = new Set();
  const tables = entries.map((entry, i) => {
    let name = slug((entry.profile && entry.profile.name) || entry.dataset.name) || `dataset_${i + 1}`;
    while (used.has(name)) name = `${name}_${i + 1}`;
    used.add(name);
    return describeTable(entry, name);
  });

  if (tables.every((t) => !t.profiled)) {
    throw fail(
      'CONNECTOR_UNREACHABLE',
      `None of the selected datasets could be read from the warehouse (${tables[0].error}). Check the connection and try again.`
    );
  }

  const joins = inferJoins(tables.filter((t) => t.profiled));
  const objects = buildObjects(tables, joins);
  const report = buildReport(tables, joins, objects);
  const sessionId = crypto.randomUUID();

  try {
    await writeObjects(connection.id, sessionId, objects);
  } catch (err) {
    if (err && err.code === '42P01') {
      throw fail(
        'SERVICE_UNAVAILABLE',
        'The context store is not set up in this database yet. Run the Context Layer schema first.'
      );
    }
    throw err;
  }

  await versions.touchDraft(actor, connection, {
    step: 'understand',
    datasetIds: selected.map((d) => d.id),
    sessionId,
    extractionReport: report,
    extractionMode: 'demo',
  });

  return {
    sessionId,
    text: report,
    toolCalls: [],
    interrupted: false,
    mode: 'demo',
    objectCount: objects.length,
  };
}

/** The latest stored extraction report for a connection, or null. */
async function latestExtraction(connectionId) {
  const row = await versions.latestExtraction(connectionId);
  if (!row) return null;
  return {
    sessionId: row.session_id,
    text: row.extraction_report,
    toolCalls: [],
    interrupted: false,
    mode: row.extraction_mode || 'demo',
    extractedAt: row.extracted_at,
  };
}

module.exports = { runDemoExtraction, latestExtraction };
