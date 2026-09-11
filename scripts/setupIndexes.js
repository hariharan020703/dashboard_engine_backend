require('../src/config/env');
const pool = require('../src/config/database');
const registry = require('../src/dashboard/dashboardRegistry');
const { resolveSourceMetadata } = require('../src/query/metadata/metadataResolver');

/**
 * Creates indexes for the columns a dashboard actually filters and groups on.
 *
 * Nothing about any particular dashboard is hardcoded: candidate columns come
 * from the dashboard JSON (slicers, groupBy, date grains) and their types come
 * from INFORMATION_SCHEMA. Measures are deliberately excluded — they are
 * aggregated, not filtered, so an index on them would not be used.
 *
 * Usage:
 *   npm run setup:indexes                                  # every registered dashboard
 *   node scripts/setupIndexes.js <dashboardId> ...   # named dashboards only
 *   node scripts/setupIndexes.js --dry-run           # print the DDL, change nothing
 *   node scripts/setupIndexes.js --prefix=80         # prefix for long text columns
 */

// MySQL cannot index these without a prefix length.
const PREFIX_REQUIRED_TYPES = new Set([
  'tinytext', 'text', 'mediumtext', 'longtext',
  'tinyblob', 'blob', 'mediumblob', 'longblob',
]);
// Types that cannot be indexed directly at all.
const UNINDEXABLE_TYPES = new Set(['json', 'geometry']);
const DEFAULT_TEXT_PREFIX = 64;
// Longest varchar/char indexed without a prefix (keeps us well inside InnoDB limits).
const MAX_INLINE_STRING_LENGTH = 191;

function parseArgs(argv) {
  const ids = [];
  let dryRun = false;
  let prefix = DEFAULT_TEXT_PREFIX;

  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '-n') dryRun = true;
    else if (arg.startsWith('--prefix=')) {
      const n = parseInt(arg.slice('--prefix='.length), 10);
      if (!Number.isInteger(n) || n < 1 || n > 255) {
        throw new Error(`Invalid --prefix value: ${arg}. Expected an integer 1-255.`);
      }
      prefix = n;
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else ids.push(arg);
  }
  return { ids, dryRun, prefix };
}

function quote(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function indexName(table, column) {
  const base = `idx_${slug(table)}_${slug(column)}`;
  return base.length <= 64 ? base : base.slice(0, 64).replace(/_+$/, '');
}

function declaredStringLength(columnType) {
  const match = /^(?:var)?char\s*\(\s*(\d+)\s*\)/i.exec(String(columnType || ''));
  return match ? parseInt(match[1], 10) : null;
}

/** How this column can be indexed, based purely on its database type. */
function indexTarget(colMeta, textPrefix) {
  const type = String(colMeta.type || '').toLowerCase();
  if (UNINDEXABLE_TYPES.has(type)) {
    return { skip: `type ${type} cannot be indexed directly` };
  }
  if (PREFIX_REQUIRED_TYPES.has(type)) {
    return { expr: `${quote(colMeta.name)}(${textPrefix})`, note: `${type}, prefix ${textPrefix}` };
  }
  const length = declaredStringLength(colMeta.columnType);
  if (length && length > MAX_INLINE_STRING_LENGTH) {
    return { expr: `${quote(colMeta.name)}(${textPrefix})`, note: `${colMeta.columnType}, prefix ${textPrefix}` };
  }
  return { expr: quote(colMeta.name), note: type };
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

  for (const kpi of spec.kpis || []) {
    addDateGrain(kpi);
    addDateGrain(kpi.series && kpi.series.main);
    addGroupBy(kpi.groupBy);
    addGroupBy(kpi.series && kpi.series.main && kpi.series.main.groupBy);
  }

  for (const card of spec.cards || []) {
    addDateGrain(card);
    addDateGrain(card.series && card.series.main);
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

async function leadingIndexedColumns(table) {
  const [rows] = await pool.query(`SHOW INDEX FROM ${quote(table)}`);
  const leading = new Set();
  const names = new Set();
  for (const row of rows) {
    names.add(row.Key_name);
    if (Number(row.Seq_in_index) === 1) leading.add(String(row.Column_name).toLowerCase());
  }
  return { leading, names };
}

(async () => {
  const { ids, dryRun, prefix } = parseArgs(process.argv.slice(2));

  const dashboards = ids.length ? ids : registry.listDashboards().map((d) => d.id);
  if (!dashboards.length) {
    console.log('No dashboards found. Nothing to index.');
    await pool.end();
    return;
  }

  console.log(`Dashboards: ${dashboards.join(', ')}${dryRun ? '  (dry run)' : ''}`);

  // table -> Map(lowercased column -> column metadata)
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

    const table = meta.table.table;
    if (!wanted.has(table)) wanted.set(table, new Map());
    const forTable = wanted.get(table);

    const columns = candidateColumns(spec);
    const resolved = [];
    for (const name of columns) {
      const colMeta = meta.table.columnMap.get(name) || meta.table.byLower.get(name.toLowerCase());
      if (!colMeta) {
        console.log(`! ${id}: column "${name}" is not in ${table}, skipping`);
        continue;
      }
      forTable.set(colMeta.name.toLowerCase(), colMeta);
      resolved.push(colMeta.name);
    }
    console.log(`  ${id} -> ${table}: ${resolved.length ? resolved.join(', ') : '(no filter/group columns)'}`);
  }

  let created = 0;
  let skipped = 0;

  for (const [table, columns] of wanted) {
    if (!columns.size) continue;
    console.log(`\n${table}`);
    const { leading, names } = await leadingIndexedColumns(table);

    for (const colMeta of columns.values()) {
      const name = indexName(table, colMeta.name);
      const target = indexTarget(colMeta, prefix);

      if (target.skip) {
        console.log(`  - ${colMeta.name}: ${target.skip}`);
        skipped += 1;
        continue;
      }
      if (leading.has(colMeta.name.toLowerCase())) {
        console.log(`  ✓ ${colMeta.name}: already the leading column of an index`);
        skipped += 1;
        continue;
      }
      if (names.has(name)) {
        console.log(`  ✓ ${name}: already exists`);
        skipped += 1;
        continue;
      }

      const sql = `CREATE INDEX ${quote(name)} ON ${quote(table)} (${target.expr})`;
      if (dryRun) {
        console.log(`  ~ ${sql}   -- ${target.note}`);
      } else {
        await pool.query(sql);
        console.log(`  + ${name} on ${colMeta.name} (${target.note})`);
      }
      created += 1;
    }
  }

  console.log(`\n${dryRun ? 'Would create' : 'Created'}: ${created}, skipped: ${skipped}`);
  await pool.end();
})().catch((e) => {
  console.error('ERROR', e.message);
  process.exit(1);
});
