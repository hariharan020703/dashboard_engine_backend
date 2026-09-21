require('../src/config/env');
const { db } = require('../src/config/database');
const registry = require('../src/dashboard/dashboardRegistry');
const { resolveSourceMetadata } = require('../src/query/metadataResolver');
const { quoteIdentifier, quoteQualified } = require('../src/query/semanticLayer');

/**
 * Creates indexes for the columns a dashboard actually filters and groups on.
 *
 * Nothing about any particular dashboard is hardcoded: candidate columns come
 * from the dashboard JSON (slicers, groupBy, date grains) and their types come
 * from the catalogue. Measures are deliberately excluded - they are aggregated,
 * not filtered, so an index on them would not be used.
 *
 * Usage:
 *   npm run setup:indexes                            # every registered dashboard
 *   node scripts/setupIndexes.js <dashboardId> ...   # named dashboards only
 *   node scripts/setupIndexes.js --dry-run           # print the DDL, change nothing
 */

/*
 * Types PostgreSQL's default btree cannot index directly.
 *
 * Short, because there is no prefix-length requirement for long text: btree
 * indexes `text` and `varchar` identically and without a declared length, and
 * an oversized value is rejected at insert time rather than needing a prefix
 * declared up front.
 */
const UNINDEXABLE_TYPES = new Set(['json', 'xml', 'point', 'polygon', 'line', 'lseg', 'path', 'box', 'circle']);

// PostgreSQL truncates identifiers at 63 bytes; a truncated index name would
// silently collide with another.
const MAX_IDENTIFIER_LENGTH = 63;

function parseArgs(argv) {
  const ids = [];
  let dryRun = false;

  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '-n') dryRun = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else ids.push(arg);
  }
  return { ids, dryRun };
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function indexName(table, column, suffix = '') {
  const base = `idx_${slug(table)}_${slug(column)}${suffix}`;
  return base.length <= MAX_IDENTIFIER_LENGTH
    ? base
    : base.slice(0, MAX_IDENTIFIER_LENGTH).replace(/_+$/, '');
}

/**
 * The index expressions worth creating for one column.
 *
 * Two of them, for a non-text column. Slicer values arrive from a URL as
 * strings, so the engine compares `column::text = $1` (see
 * semanticLayer.buildWhereSql), and a plain index on an integer column cannot
 * serve that - PostgreSQL only uses an index whose expression matches. So an
 * expression index on the cast is created alongside the ordinary one, which
 * still serves GROUP BY and ORDER BY.
 */
function indexTargets(colMeta) {
  const type = String(colMeta.type || '').toLowerCase();
  if (UNINDEXABLE_TYPES.has(type)) {
    return { skip: `type ${type} cannot be indexed with a default btree` };
  }

  const col = quoteIdentifier(colMeta.name);
  const targets = [{ expr: col, suffix: '', note: type }];

  if (!colMeta.isString) {
    targets.push({
      expr: `((${col})::text)`,
      suffix: '_text',
      note: `${type} cast to text, for slicer filters`,
    });
  }
  return { targets };
}

/**
 * Columns worth indexing for a spec: anything the engine puts in a WHERE or
 * GROUP BY clause. Measure columns are intentionally not collected.
 */
function candidateColumns(spec) {
  const columns = new Set();
  const add = (name) => {
    if (typeof name === 'string' && name.trim()) columns.add(name.trim());
  };
  const addGroupBy = (list) => {
    for (const g of list || []) add(g && g.column);
  };
  const addDateGrain = (node) => {
    if (node && node.dateGrain && typeof node.dateGrain === 'object') add(node.dateGrain.column);
  };

  for (const slicer of spec.slicers || []) add(slicer.column);

  // KPIs and charts are one list; the registry has already flattened both.
  for (const card of spec.cards || []) {
    addDateGrain(card);
    addGroupBy(card.groupBy);
    // A card with no explicit groupBy groups by its category column.
    if (!(card.groupBy && card.groupBy.length)) {
      for (const col of card.columns || []) {
        if (['XTIME', 'SERIES', 'ITEM'].includes(col.mapping)) add(col.column);
      }
    }
    for (const term of [].concat(card.orderBy || [], card.sort || [])) {
      if (typeof term === 'string') add(term);
      else if (term) add(term.column || term.field || term.name);
    }
  }

  return [...columns];
}

/**
 * What is already indexed on a table: the index names, and the first column of
 * each so an existing composite index counts as covering its leading column.
 */
async function existingIndexes(schema, table) {
  const { rows } = await db.query(
    `SELECT i.relname AS index_name,
            a.attname AS column_name,
            k.ordinality AS position
       FROM pg_class      t
       JOIN pg_namespace  n  ON n.oid = t.relnamespace
       JOIN pg_index      ix ON ix.indrelid = t.oid
       JOIN pg_class      i  ON i.oid = ix.indexrelid
       CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ordinality)
       LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE n.nspname = ? AND t.relname = ?`,
    [schema, table]
  );

  const leading = new Set();
  const names = new Set();
  for (const row of rows) {
    names.add(row.index_name);
    // attnum 0 marks an expression rather than a plain column; those have no
    // attname and are matched by index name instead.
    if (Number(row.position) === 1 && row.column_name) {
      leading.add(String(row.column_name).toLowerCase());
    }
  }
  return { leading, names };
}

(async () => {
  const { ids, dryRun } = parseArgs(process.argv.slice(2));

  const dashboards = ids.length ? ids : registry.listDashboards().map((d) => d.id);
  if (!dashboards.length) {
    console.log('No dashboards found. Nothing to index.');
    await db.end();
    return;
  }

  console.log(`Dashboards: ${dashboards.join(', ')}${dryRun ? '  (dry run)' : ''}`);

  // "schema.table" -> { schema, table, columns: Map(lowercased name -> metadata) }
  const wanted = new Map();

  for (const id of dashboards) {
    let spec;
    try {
      spec = registry.resolveSpec(id);
    } catch (err) {
      console.log(`! ${id}: ${err.message}`);
      continue;
    }

    let meta;
    try {
      meta = await resolveSourceMetadata(spec);
    } catch (err) {
      console.log(`! ${id}: ${err.message}`);
      continue;
    }

    const { schema, table } = meta.table;
    const key = `${schema}.${table}`;
    if (!wanted.has(key)) wanted.set(key, { schema, table, columns: new Map() });
    const entry = wanted.get(key);

    const resolved = [];
    for (const name of candidateColumns(spec)) {
      const colMeta = meta.table.columnMap.get(name) || meta.table.byLower.get(name.toLowerCase());
      if (!colMeta) {
        console.log(`! ${id}: column "${name}" is not in ${key}, skipping`);
        continue;
      }
      entry.columns.set(colMeta.name.toLowerCase(), colMeta);
      resolved.push(colMeta.name);
    }
    console.log(`  ${id} -> ${key}: ${resolved.length ? resolved.join(', ') : '(no filter/group columns)'}`);
  }

  let created = 0;
  let skipped = 0;

  for (const [key, { schema, table, columns }] of wanted) {
    if (!columns.size) continue;
    console.log(`\n${key}`);
    const { leading, names } = await existingIndexes(schema, table);

    for (const colMeta of columns.values()) {
      const { skip, targets } = indexTargets(colMeta);
      if (skip) {
        console.log(`  - ${colMeta.name}: ${skip}`);
        skipped += 1;
        continue;
      }

      for (const target of targets) {
        const name = indexName(table, colMeta.name, target.suffix);

        // A plain index is covered by any index that already leads with the
        // column; an expression index is matched by name only.
        if (!target.suffix && leading.has(colMeta.name.toLowerCase())) {
          console.log(`  = ${colMeta.name}: already the leading column of an index`);
          skipped += 1;
          continue;
        }
        if (names.has(name)) {
          console.log(`  = ${name}: already exists`);
          skipped += 1;
          continue;
        }

        const sql =
          `CREATE INDEX ${quoteIdentifier(name)} ON ${quoteQualified(schema, table)} (${target.expr})`;
        if (dryRun) {
          console.log(`  ~ ${sql}   -- ${target.note}`);
        } else {
          await db.query(sql);
          console.log(`  + ${name} on ${colMeta.name} (${target.note})`);
        }
        created += 1;
      }
    }
  }

  console.log(`\n${dryRun ? 'Would create' : 'Created'}: ${created}, skipped: ${skipped}`);
  await db.end();
})().catch((e) => {
  console.error('ERROR', e.message);
  process.exit(1);
});
