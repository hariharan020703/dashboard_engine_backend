const express = require('express');
const { requestTimer } = require('../middleware/requestTimer');
const { sendError, ok } = require('../api/response');
const { isRbacReady, rbacError } = require('../auth/appMetaSchema');
const { describeTransport } = require('../email/emailService');
const authRoutes = require('./authRoutes');
const companyRoutes = require('./companyRoutes');
const userRoutes = require('./userRoutes');
const roleRoutes = require('./roleRoutes');
const groupRoutes = require('./groupRoutes');
const accessRoutes = require('./accessRoutes');
const dashboardRoutes = require('./dashboardRoutes');
const metadataRoutes = require('./metadataRoutes');
const auditRoutes = require('./auditRoutes');
const contextLayerRoutes = require('../modules/context-layer/routes');

/** Everything under /api. Mounted by the server as a single unit. */
const router = express.Router();

router.use(requestTimer);

/*
 * The only unauthenticated endpoint. Reports whether the process is able to
 * serve, and nothing about who is using it or what is in it.
 */
router.get('/health', (req, res) => {
  const ready = isRbacReady();
  res.status(ready ? 200 : 503);
  ok(res, {
    status: ready ? 'ok' : 'starting',
    detail: ready ? null : rbacError(),
    email: describeTransport().provider,
  });
});

/*
 * Every router below enforces its own guards - see middleware/auth.js. There is
 * no longer an unguarded namespace: the dashboard and editor routes used to be
 * open to anonymous callers and are now behind the same actor resolution and
 * the same per-dashboard access check as everything else.
 */
router.use('/auth', authRoutes);
router.use('/companies', companyRoutes);
router.use('/users', userRoutes);
router.use('/roles', roleRoutes);
router.use('/groups', groupRoutes);
router.use('/access', accessRoutes);
router.use('/audit', auditRoutes);

// Feature modules live under src/modules and are mounted as whole units, so
// adding or removing one touches this line and nothing else.
router.use('/context', contextLayerRoutes);

/*
 * Both dashboard routers mount UNDER /dashboard rather than at the root.
 *
 * Mounted at the root, their router-level `use(requireAuth, ...)` ran for every
 * unmatched /api path too, so a typo'd URL came back 401 instead of 404 -
 * middleware attached to a router applies to the whole mount point, not only to
 * the paths that router actually declares.
 *
 * The editor's literal paths are mounted first so /dashboard/columns and
 * /dashboard/preview are matched before /dashboard/:dashboardId can claim them.
 */
router.use('/dashboard', metadataRoutes);
router.use('/dashboard', dashboardRoutes);

// An unmatched /api path is a client error, not a request for the SPA shell.
router.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'RESOURCE_NOT_FOUND',
      message: `Unknown API endpoint: ${req.method} /api${req.path}`,
    },
  });
});

/*
 * Terminal error handler for /api.
 *
 * Express 5 forwards a rejected promise from an async handler automatically, so
 * routes throw an ApiError and one place turns a code into a status and a body.
 * Nothing below this point decides what an error looks like on the wire.
 */
// eslint-disable-next-line no-unused-vars -- Express identifies the error handler by arity.
router.use((err, req, res, next) => {
  sendError(res, err, `${req.method} /api${req.path}`);
});

module.exports = router;
