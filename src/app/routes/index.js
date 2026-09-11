const express = require('express');
const { requestTimer } = require('../middleware/requestTimer');
const dashboardRoutes = require('./dashboardRoutes');
const metadataRoutes = require('./metadataRoutes');

/** Everything under /api. Mounted by the server as a single unit. */
const router = express.Router();

router.use(requestTimer);
// Literal editor routes before dashboardRoutes' /dashboard/:dashboardId.
router.use(metadataRoutes);
router.use(dashboardRoutes);

// An unmatched /api path is a client error, not a request for the SPA shell.
router.use((req, res) => {
  res.status(404).json({
    error: `Unknown API endpoint: ${req.method} /api${req.path}`,
    code: 'NOT_FOUND',
  });
});

module.exports = router;
