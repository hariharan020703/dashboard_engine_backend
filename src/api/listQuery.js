const { fail } = require('./response');

/**
 * The one contract every paged list endpoint speaks.
 *
 * Request:   ?page=1&pageSize=25&search=text&sort=<key>&dir=asc|desc
 * Response:  { items: [...one page...], total: <rows matching, before paging> }
 *
 * Why the server does this at all: a list screen that downloads every row and
 * then searches, sorts and slices it in the browser costs the whole table on
 * every visit - in the query, in serialisation, on the wire and in the
 * browser's memory - to show fifteen rows. Here the database filters, orders
 * and limits, and only the visible page leaves it.
 *
 * `sort` is never interpolated as given. Each endpoint declares a map from the
 * public sort key to a SQL ORDER BY expression, and anything outside that map
 * is refused - so a sort parameter is a choice among known expressions, not a
 * way to write SQL.
 *
 * The total is computed in the same statement (`COUNT(*) OVER ()`), so paging
 * costs no second round trip. See pagedRows().
 */

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 100;

function intParam(value, fallback, { min, max, name }) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
    throw fail('VALIDATION_ERROR', `${name} must be a whole number${max ? ` from ${min} to ${max}` : ` of at least ${min}`}.`);
  }
  return n;
}

/**
 * Validates the paging/search/sort parameters of a request.
 *
 * @param query      req.query
 * @param sortable   { publicKey: 'SQL ORDER BY expression' }
 * @param defaults   { sort, dir, pageSize }
 */
function parseListQuery(query, sortable, defaults = {}) {
  const page = intParam(query.page, 1, { min: 1, name: 'page' });
  const pageSize = intParam(query.pageSize, defaults.pageSize || DEFAULT_PAGE_SIZE, {
    min: 1,
    max: MAX_PAGE_SIZE,
    name: 'pageSize',
  });

  const search = typeof query.search === 'string' ? query.search.trim().slice(0, MAX_SEARCH_LENGTH) : '';

  const sort = query.sort === undefined || query.sort === '' ? defaults.sort : String(query.sort);
  if (sort !== undefined && !Object.prototype.hasOwnProperty.call(sortable, sort)) {
    throw fail('VALIDATION_ERROR', `sort must be one of: ${Object.keys(sortable).join(', ')}.`);
  }
  const dirRaw = query.dir === undefined || query.dir === '' ? defaults.dir || 'asc' : String(query.dir);
  if (dirRaw !== 'asc' && dirRaw !== 'desc') {
    throw fail('VALIDATION_ERROR', 'dir must be asc or desc.');
  }

  return { page, pageSize, offset: (page - 1) * pageSize, search, sort, dir: dirRaw };
}

/** `%text%` for ILIKE, with the pattern characters in the user's text escaped. */
function likePattern(search) {
  return `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * ORDER BY for a parsed query. Absent values sort last in both directions -
 * a row with no "last active" is not the earliest date, it is a row with
 * nothing to compare - and `tiebreak` keeps paging stable when values repeat.
 */
function orderBy(list, sortable, tiebreak) {
  const expression = sortable[list.sort];
  const direction = list.dir === 'desc' ? 'DESC' : 'ASC';
  return `ORDER BY ${expression} ${direction} NULLS LAST, ${tiebreak}`;
}

/**
 * Runs a SELECT that already carries `COUNT(*) OVER () AS "__total"` and a
 * LIMIT/OFFSET, and returns { items, total }.
 *
 * A page past the end has no rows to carry the window count, so in that one
 * case the total is recounted - the rare path pays, not the common one.
 */
async function pagedRows(client, sql, params, countSql, countParams, shape) {
  const { rows } = await client.query(sql, params);
  let total;
  if (rows.length) {
    total = Number(rows[0].__total);
  } else {
    const counted = await client.query(countSql, countParams);
    total = Number(counted.rows[0].n);
  }
  return { items: rows.map(shape), total };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  parseListQuery,
  likePattern,
  orderBy,
  pagedRows,
};
