function executeQuery(pool, sql, params) {
  const start = Date.now();
  return pool.query(sql, params || [])
    .then(([rows]) => {
      const elapsed = Date.now() - start;
      return { rows, elapsed };
    })
    .catch((err) => {
      const elapsed = Date.now() - start;
      console.error(`[QueryExecutor] SQL failed (${elapsed}ms):`, err.message);
      console.error('[QueryExecutor] SQL:', sql);
      console.error('[QueryExecutor] Params:', params);
      throw err;
    });
}

module.exports = { executeQuery };
