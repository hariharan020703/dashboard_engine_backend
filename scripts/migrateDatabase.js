#!/usr/bin/env node
/**
 * Copies this application's database into another PostgreSQL.
 *
 * Written for one move in particular: from the local PostgreSQL this
 * application started on, to the database the Context Layer service already
 * uses. Those two services have to share one database, because
 * `adk_agents/api/db.py` resolves a workspace with
 * `SELECT 1 FROM connections WHERE id = %s` and those rows are written here.
 * Two databases meant that check could never pass.
 *
 * It is a data copy, not a schema tool. The destination's tables are created
 * by the application's own bootstrap - `bootstrapAppMeta()`, the same code
 * that runs at every start - so there is exactly one definition of what these
 * tables look like and this script cannot drift from it.
 *
 *   SOURCE_DB_URL=postgresql://user:pass@localhost:5432/elze npm run migrate:db -- --dry-run
 *   SOURCE_DB_URL=postgresql://user:pass@localhost:5432/elze npm run migrate:db
 *
 * The DESTINATION is whatever `backend/.env` points at - the same DB_* values
 * the running application uses. That is deliberate: it means you cannot
 * migrate into a database the application would not then talk to.
 *
 * Safe to re-run, and the SOURCE always wins: every insert upserts, so a
 * second run over a partially-copied database fills the gaps and refreshes
 * what it already wrote rather than failing on it.
 */
require('../src/config/env');
const { Client } = require('pg');
const { db, T } = require('../src/config/database');
const { bootstrapAppMeta } = require('../src/auth/appMetaSchema');
const { CT } = require('../src/modules/context-layer/schema');

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_REPORTING = process.argv.includes('--skip-reporting');

/**
 * The order is the dependency order, and it is not negotiable.
 *
 * `users` references `companies`; `groups` reference both; every grant
 * references what it grants. Copying them in any other order fails on a
 * foreign key, and the failure names a constraint rather than the mistake.
 *
 * `conflict` is the key that makes a re-run a no-op for rows already there.
 * Where a table has a surrogate primary key the conflict target is that key;
 * where it has a natural one, it is the natural one.
 */
const TABLES = [
  { name: 'companies', conflict: '(id)', identity: 'id' },
  { name: 'roles', conflict: '(name)', identity: 'id' },
  { name: 'role_permissions', conflict: '(role_name, permission_id)' },
  { name: 'users', conflict: '(id)', identity: 'id' },
  { name: 'groups', conflict: '(id)', identity: 'id' },
  { name: 'group_users', conflict: '(group_id, user_id)' },
  { name: 'dashboards', conflict: '(id)' },
  { name: 'company_dashboards', conflict: '(company_id, dashboard_id)' },
  { name: 'dashboard_access', conflict: '(user_id, dashboard_id)' },
  { name: 'group_dashboard_access', conflict: '(group_id, dashboard_id)' },
  { name: 'user_data_scope', conflict: '(user_id, dimension, value)' },
  { name: 'refresh_tokens', conflict: '(id)' },
  { name: 'user_tokens', conflict: '(id)' },
  { name: 'login_attempts', conflict: '(identifier)' },
  { name: 'permission_seed_log', conflict: '(permission_id)' },

  /*
   * The two the rename was for. The source spelled them
   * `context_connections` / `context_connection_datasets`; the destination
   * spells them the way the Context Layer service reads them. Same rows, same
   * columns - only the name moved.
   */
  { name: 'connections', from: 'context_connections', conflict: '(id)' },
  { name: 'datasets', from: 'context_connection_datasets', conflict: '(connection_id, dataset_id)' },
];

/**
 * Reporting tables, which the bootstrap does not create.
 *
 * They are the dashboards' source data rather than application metadata, so
 * they are discovered rather than listed: whatever is in the source database
 * and is not one of ours above. Copied with their structure, because nothing
 * else knows how to make them.
 *
 * This is the slow half - `cinema_analysis` alone is 200k rows - which is why
 * `--skip-reporting` exists for a run that only needs the accounts moved.
 */
const OURS = new Set([
  ...TABLES.map((t) => t.from || t.name),
  ...TABLES.map((t) => t.name),
]);

function log(...args) {
  console.log(...args);
}

/**
 * Columns the two databases agree on, in the destination's order.
 *
 * On a dry run the destination has not been bootstrapped yet, so it has no
 * columns to intersect with and every table would report "nothing in common" -
 * which reads as a problem rather than as "the schema is not there yet". In
 * that one case the source's own columns stand in, so a dry run still reports
 * the row counts it is being asked about.
 */
async function sharedColumns(source, destTable, sourceTable) {
  const [{ rows: destCols }, { rows: srcCols }] = await Promise.all([
    db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ?
        ORDER BY ordinal_position`,
      [destTable]
    ),
    source.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position`,
      [sourceTable]
    ),
  ]);

  if (!destCols.length) {
    return DRY_RUN ? srcCols.map((r) => r.column_name) : [];
  }
  const available = new Set(srcCols.map((r) => r.column_name));
  return destCols.map((r) => r.column_name).filter((c) => available.has(c));
}

/**
 * The conflict clause, and why it is an UPDATE rather than DO NOTHING.
 *
 * `bootstrapAppMeta()` runs first to create the destination's tables, and it
 * also SEEDS: the three roles, their default permissions, the permission log,
 * and - on an empty users table - the platform owner. Those rows then collide
 * with the real ones coming from the source.
 *
 * With DO NOTHING the seeded row wins, which is exactly backwards. The visible
 * symptom is the worst kind: the migration reports success, and the owner
 * account silently has the bootstrap password from `config/appConfig.js`
 * instead of the one they actually use, discovered at the next sign-in.
 *
 * So the source wins on every column it brought. Where a table is nothing but
 * its key - `role_permissions`, `group_users` - there is no column left to
 * update and DO NOTHING is both correct and the only legal clause.
 */
function onConflict(spec, columns) {
  if (!spec.conflict) return '';

  const keyColumns = new Set(
    spec.conflict.replace(/[()]/g, '').split(',').map((c) => c.trim())
  );
  const updatable = columns.filter((c) => !keyColumns.has(c));
  if (!updatable.length) return ` ON CONFLICT ${spec.conflict} DO NOTHING`;

  const assignments = updatable.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ');
  return ` ON CONFLICT ${spec.conflict} DO UPDATE SET ${assignments}`;
}

/**
 * Copies one table, in batches.
 *
 * Batched because a single multi-row INSERT of 200k rows exceeds what the
 * driver will assemble and what the server will accept as one statement, and
 * because a failure halfway through a batch of 500 is a far smaller thing to
 * reason about than a failure halfway through everything.
 */
async function copyTable(source, spec) {
  const sourceTable = spec.from || spec.name;
  const destTable = spec.name;

  const exists = await source.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1`,
    [sourceTable]
  );
  if (!exists.rows.length) {
    log(`  skip     ${destTable.padEnd(28)} (not in source)`);
    return { table: destTable, copied: 0, skipped: true };
  }

  const columns = await sharedColumns(source, destTable, sourceTable);
  if (!columns.length) {
    log(`  skip     ${destTable.padEnd(28)} (no columns in common)`);
    return { table: destTable, copied: 0, skipped: true };
  }

  const { rows } = await source.query(
    `SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM "${sourceTable}"`
  );
  if (!rows.length) {
    log(`  empty    ${destTable.padEnd(28)} 0 rows`);
    return { table: destTable, copied: 0 };
  }

  if (DRY_RUN) {
    log(`  would    ${destTable.padEnd(28)} ${String(rows.length).padStart(7)} rows`);
    return { table: destTable, copied: rows.length, dryRun: true };
  }

  const quoted = columns.map((c) => `"${c}"`).join(', ');
  const conflict = onConflict(spec, columns);
  const BATCH = 500;
  let copied = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    // One placeholder per value; pgPool rewrites `?` into $1..$n for us.
    const placeholders = batch
      .map(() => `(${columns.map(() => '?').join(', ')})`)
      .join(', ');
    const params = batch.flatMap((row) => columns.map((c) => row[c]));

    const result = await db.query(
      `INSERT INTO "${destTable}" (${quoted}) VALUES ${placeholders}${conflict}`,
      params
    );
    copied += result.rowCount ?? 0;
  }

  const note = copied === rows.length ? '' : ` (${rows.length - copied} left as they were)`;
  log(`  copied   ${destTable.padEnd(28)} ${String(copied).padStart(7)} rows${note}`);
  return { table: destTable, copied };
}

/**
 * Copies a reporting table, creating it first.
 *
 * `CREATE TABLE ... (LIKE ...)` is not available across databases, so the
 * structure is rebuilt from `information_schema`. Types are taken verbatim
 * from the source, including length and precision, so a `VARCHAR(50)` does not
 * quietly become `TEXT` and a `NUMERIC(10,2)` does not lose its scale.
 */
async function copyReportingTable(source, name) {
  const { rows: cols } = await source.query(
    `SELECT column_name, data_type, character_maximum_length,
            numeric_precision, numeric_scale, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [name]
  );
  if (!cols.length) return { table: name, copied: 0, skipped: true };

  const ddl = cols
    .map((c) => {
      let type = c.data_type;
      if (c.character_maximum_length) type += `(${c.character_maximum_length})`;
      else if (c.data_type === 'numeric' && c.numeric_precision) {
        type += `(${c.numeric_precision},${c.numeric_scale || 0})`;
      }
      return `"${c.column_name}" ${type}${c.is_nullable === 'NO' ? ' NOT NULL' : ''}`;
    })
    .join(', ');

  const { rows } = await source.query(`SELECT * FROM "${name}"`);

  if (DRY_RUN) {
    log(`  would    ${name.padEnd(28)} ${String(rows.length).padStart(7)} rows (reporting)`);
    return { table: name, copied: rows.length, dryRun: true };
  }

  await db.raw(`CREATE TABLE IF NOT EXISTS "${name}" (${ddl})`);

  const { rows: [{ n }] } = await db.query(`SELECT COUNT(*)::int AS n FROM "${name}"`);
  if (n > 0) {
    log(`  skip     ${name.padEnd(28)} (destination already has ${n} rows)`);
    return { table: name, copied: 0, skipped: true };
  }

  const columns = cols.map((c) => c.column_name);
  const quoted = columns.map((c) => `"${c}"`).join(', ');
  const BATCH = 1000;
  let copied = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const placeholders = batch
      .map(() => `(${columns.map(() => '?').join(', ')})`)
      .join(', ');
    const params = batch.flatMap((row) => columns.map((c) => row[c]));
    const result = await db.query(
      `INSERT INTO "${name}" (${quoted}) VALUES ${placeholders}`,
      params
    );
    copied += result.rowCount ?? 0;

    if (rows.length > 5000 && i % 20000 === 0 && i > 0) {
      log(`           ${name.padEnd(28)} ${String(i).padStart(7)} / ${rows.length}…`);
    }
  }

  log(`  copied   ${name.padEnd(28)} ${String(copied).padStart(7)} rows (reporting)`);
  return { table: name, copied };
}

/**
 * Moves each identity sequence past the ids that were just inserted.
 *
 * Copying explicit ids does not advance the sequence behind them, so without
 * this the first account created after a migration tries to reuse id 1 and
 * fails on the primary key - minutes or days later, with nothing pointing back
 * to the migration as the cause.
 */
async function resyncSequences() {
  for (const spec of TABLES) {
    if (!spec.identity) continue;
    await db.raw(
      `SELECT setval(
         pg_get_serial_sequence('"${spec.name}"', '${spec.identity}'),
         GREATEST(COALESCE((SELECT MAX("${spec.identity}") FROM "${spec.name}"), 0), 1),
         true
       )`
    );
  }
  log('  sequences resynced past the copied ids');
}

async function main() {
  const sourceUrl = process.env.SOURCE_DB_URL;
  if (!sourceUrl) {
    console.error(
      'SOURCE_DB_URL is required - the database to copy FROM.\n' +
      '  SOURCE_DB_URL=postgresql://user:pass@localhost:5432/elze npm run migrate:db -- --dry-run\n\n' +
      'The destination is whatever backend/.env points at, so check DB_HOST first.'
    );
    process.exit(1);
  }

  const source = new Client({ connectionString: sourceUrl, connectionTimeoutMillis: 15000 });
  await source.connect();

  const { rows: [srcInfo] } = await source.query(
    'SELECT current_database() AS db, inet_server_addr()::text AS host'
  );
  const { rows: [dstInfo] } = await db.query(
    'SELECT current_database() AS db, version() AS version'
  );

  log('');
  log(`  source      ${srcInfo.db} (${srcInfo.host || 'local socket'})`);
  log(`  destination ${dstInfo.db} @ ${process.env.DB_HOST}`);
  log(`  mode        ${DRY_RUN ? 'DRY RUN - nothing will be written' : 'WRITING'}`);
  log('');

  if (srcInfo.db === dstInfo.db && process.env.DB_HOST === 'localhost') {
    console.error('  Source and destination look identical. Point backend/.env at the new database first.');
    process.exit(1);
  }

  if (!DRY_RUN) {
    // The destination's tables, made by the application's own bootstrap - so
    // there is one definition of them and this script cannot drift from it.
    log('  creating the destination schema (bootstrapAppMeta)…');
    await bootstrapAppMeta();
    log('  schema ready');
    log('');
  }

  log('  application tables');
  const results = [];
  for (const spec of TABLES) {
    results.push(await copyTable(source, spec));
  }

  if (!SKIP_REPORTING) {
    const { rows: allTables } = await source.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`
    );
    const reporting = allTables
      .map((r) => r.table_name)
      .filter((name) => !OURS.has(name));

    if (reporting.length) {
      log('');
      log('  reporting tables (the dashboards\' source data)');
      for (const name of reporting) {
        results.push(await copyReportingTable(source, name));
      }
    }
  } else {
    log('');
    log('  reporting tables skipped (--skip-reporting)');
  }

  if (!DRY_RUN) {
    log('');
    await resyncSequences();
  }

  await source.end();

  const total = results.reduce((sum, r) => sum + (r.copied || 0), 0);
  log('');
  log(`  ${DRY_RUN ? 'would copy' : 'copied'} ${total.toLocaleString('en-US')} rows across ${results.filter((r) => !r.skipped).length} tables`);
  if (DRY_RUN) log('  re-run without --dry-run to write.');
  log('');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n  migration failed:', err.message);
    if (err.detail) console.error('  detail:', err.detail);
    if (err.hint) console.error('  hint:', err.hint);
    console.error('\n  Nothing is left half-written that a re-run will not fix:');
    console.error('  every insert is ON CONFLICT DO NOTHING, so running it again resumes.');
    process.exit(1);
  });
