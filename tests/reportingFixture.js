const { db } = require('../src/config/database');
const { quoteIdentifier } = require('../src/config/pgPool');

/**
 * Creates the reporting table the default dashboard reads, with synthetic rows.
 *
 * The suite needs one, because the RBAC tables and the reporting tables now
 * share a database: a suite run against an empty database can prove everything
 * about access control and nothing about whether a granted dashboard actually
 * renders.
 *
 * The column names are the awkward ones from the real table on purpose -
 * spaces, mixed case, a text column holding dates as "15-Aug-23". Those are
 * what the identifier quoting and the to_date template have to survive, and a
 * fixture of tidy snake_case columns would prove none of it.
 */

const COLUMNS = [
  ['Booking Date', 'text'],
  ['Booking Id', 'text'],
  ['Booking Type', 'text'],
  ['Genre', 'text'],
  ['Movie Name', 'text'],
  ['Status', 'text'],
  ['Theater Name', 'text'],
  ['AVG RATING', 'double precision'],
  ['Budget', 'double precision'],
  ['OCCUPANCY RATE', 'double precision'],
  ['Revenue', 'double precision'],
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const GENRES = ['Action', 'Comedy', 'Drama', 'Horror', 'Romantic', 'Thriller'];
const STATUSES = ['Confirmed', 'Pending', 'Cancelled'];
const TYPES = ['Online', 'Offline'];
const THEATERS = ['Williams PLC', 'Bell-White', 'Matthews-Rogers'];
const MOVIES = ['Funny Business', 'Silent Threat', 'The Promise', 'Red Alert'];

/*
 * Dimensions are chosen by a hash of the row number rather than by `i % n`.
 *
 * Modular strides correlate with the calendar - `i % 6` for genre against a
 * 12-month cycle puts each genre in only two months - and a fixture where a
 * filtered total equals the unfiltered one cannot tell a working filter from
 * an ignored one. The `>>> 0` matters too: XOR yields a signed 32-bit integer,
 * and a negative index produces day "-16" and an undefined month name.
 */
function hash(i, salt) {
  let h = (i + 1) * 2654435761 + salt * 40503;
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

const pick = (list, i, salt) => list[hash(i, salt) % list.length];

function buildRow(i) {
  const day = (hash(i, 2) % 27) + 1;
  return [
    `${day}-${MONTHS[hash(i, 1) % 12]}-23`,
    `B${10000 + i}`,
    pick(TYPES, i, 5),
    pick(GENRES, i, 3),
    pick(MOVIES, i, 7),
    pick(STATUSES, i, 4),
    pick(THEATERS, i, 6),
    Number(((hash(i, 11) % 100) / 10).toFixed(1)),
    Number(((hash(i, 12) % 90000) / 10).toFixed(2)),
    Number(((hash(i, 13) % 1000) / 10).toFixed(1)),
    Number(((hash(i, 14) % 50000) / 10).toFixed(2)),
  ];
}

const q = quoteIdentifier;

/*
 * Written as the table's comment, and checked before anything is dropped.
 *
 * The fixture connects through the application's own pool, which reads .env -
 * so running the suite without overriding DB_NAME points it at the real
 * database, where a bare `DROP TABLE IF EXISTS cinema_analysis` destroys the
 * reporting table it was meant to imitate. Refusing to drop a table this
 * fixture did not create turns that from data loss into an error message.
 */
const FIXTURE_MARKER = 'rbac.e2e synthetic fixture - safe to drop';

/** The table's comment, or null when the table does not exist. */
async function fixtureMarker(schema, table) {
  const { rows } = await db.query(
    `SELECT obj_description(c.oid) AS comment
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ? AND c.relname = ? AND c.relkind = 'r'`,
    [schema, table]
  );
  return rows.length ? rows[0].comment : null;
}

async function createReportingFixture({ schema = 'public', table = 'cinema_analysis', rows = 600 } = {}) {
  const ref = `${q(schema)}.${q(table)}`;

  const existing = await fixtureMarker(schema, table);
  if (existing !== null && existing !== FIXTURE_MARKER) {
    const { rows: where } = await db.query('SELECT current_database() AS db');
    throw new Error(
      `Refusing to replace ${schema}.${table} in database "${where[0].db}": it was not created by ` +
      'this fixture, and dropping it would destroy real data. Point the suite at a throwaway ' +
      'database - set DB_NAME on the test process as well as on the server.'
    );
  }

  await db.raw(`DROP TABLE IF EXISTS ${ref}`);
  await db.raw(`CREATE TABLE ${ref} (${COLUMNS.map(([n, t]) => `${q(n)} ${t} NULL`).join(', ')})`);
  await db.raw(`COMMENT ON TABLE ${ref} IS '${FIXTURE_MARKER}'`);

  const cols = COLUMNS.map(([n]) => q(n)).join(', ');
  const values = [];
  const params = [];
  for (let i = 0; i < rows; i++) {
    const row = buildRow(i);
    const base = params.length;
    values.push('(' + row.map((_, k) => `$${base + k + 1}`).join(', ') + ')');
    params.push(...row);
  }
  // `raw` rather than `query`: the placeholders are already positional.
  await db.raw(`INSERT INTO ${ref} (${cols}) VALUES ${values.join(', ')}`, params);

  return { schema, table, rows };
}

module.exports = { createReportingFixture };
