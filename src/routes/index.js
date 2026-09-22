const express = require('express');
const { requestTimer } = require('../middleware/requestTimer');
const { sendError, ok } = require('../api/response');
const { isRbacReady, rbacError } = require('../auth/appMetaSchema');
const { describeTransport } = require('../email/emailService');
const authRoutes = require('./authRoutes');
const platformRoutes = require('./platformRoutes');
const workspaceRoutes = require('./workspaceRoutes');
const userRoutes = require('./userRoutes');
const groupRoutes = require('./groupRoutes');
const accessRoutes = require('./accessRoutes');
const dashboardRoutes = require('./dashboardRoutes');
const metadataRoutes = require('./metadataRoutes');
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
 * The API is split into two namespaces by the SCOPE of what they operate on.
 *
 *   /api/platform/*   crosses tenants: the company directory, the cross-tenant
 *                     user directory, the permission model, the audit trail.
 *                     Gated as a whole by requirePlatform.
 *
 *   /api/*            is one tenant's: their team, their groups, their grants,
 *                     their dashboards, their connections. The company comes
 *                     from req.actor, so these routes answer about the caller's
 *                     own company whoever calls them.
 *
 * The URL therefore says which boundary a request is asking to cross, which is
 * the thing an audit log reader, a proxy rule and a reviewer all want to know
 * first. It is not a second authorization mechanism: every router below still
 * enforces its own permissions and its own company filter, and /api/platform
 * mounts several of these same router objects rather than cloning them.
 */
router.use('/auth', authRoutes);
router.use('/platform', platformRoutes);

router.use('/workspace', workspaceRoutes);
router.use('/users', userRoutes);
router.use('/groups', groupRoutes);
router.use('/access', accessRoutes);

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
