const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { DIST_DIR } = require('./config/env');
const { APPLICATION_URL } = require('./config/auth');
const apiRoutes = require('./routes');
const { bootstrapAppMeta } = require('./auth/appMetaSchema');
const { pruneExpiredTokens } = require('./auth/tokenService');
const { pruneAttempts } = require('./auth/loginThrottle');

/**
 * The API process.
 *
 * Configuration is read at require time by config/auth.js and config/email.js,
 * both of which throw on anything missing. A process that starts is therefore a
 * process that is fully configured - there is no state where it runs with a
 * default secret or a mail transport nobody chose.
 */

const app = express();

/*
 * The browser and the API are same-origin in every supported deployment: this
 * process serves the built frontend, and the Vite dev server proxies /api to
 * it. So cross-origin credentialed requests are not a case that needs to work,
 * and CORS stays closed rather than being opened with a wildcard - which, with
 * cookie sessions, would be handing the session to any site that asked.
 */
app.use(cors({ origin: APPLICATION_URL, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.use('/api', apiRoutes);

// Frontend build output, with SPA fallback for client-side routes.
app.use(express.static(DIST_DIR));
app.get('{*splat}', (req, res) => {
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

const PORT = process.env.PORT || 8080;

/**
 * Creates the RBAC tables if they are missing, retrying while PostgreSQL warms up.
 *
 * Fatal on failure. Every endpoint resolves an actor and checks a grant, so a
 * process that cannot reach the database cannot authorize anything - staying up
 * would mean serving 503 to every request while looking healthy to whatever
 * restarts it.
 */
async function bootstrapRbac(attempts = 5, delayMs = 3000) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await bootstrapAppMeta();
      console.log('[rbac] metadata database ready');
      return;
    } catch (err) {
      const last = attempt === attempts;
      console.warn(
        `[rbac] bootstrap failed (${err.code || err.message})` +
        (last ? '' : `, retrying in ${delayMs / 1000}s...`)
      );
      if (last) {
        console.error('[rbac] giving up. The metadata database must be reachable to serve any request.');
        console.error(`[rbac] last error: ${err.message}`);
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Confirms the mail transport can actually be used.
 *
 * Non-fatal on purpose, and the one place that judgement differs from the rest
 * of startup: a mail server that is briefly unreachable should not stop people
 * opening dashboards. Onboarding will fail loudly at the moment it is attempted.
 */
async function verifyEmailTransport() {
  try {
    await require('./email/providers/smtpProvider').verify();
    console.log('[email] SMTP relay reachable and credentials accepted');
  } catch (err) {
    console.warn(
      `[email] SMTP is not usable: ${err.message}. Creating a user will fail until this is fixed.`
    );
  }
}

/**
 * Housekeeping for the two tables that grow on their own.
 *
 * Expired refresh rows are kept for a week after expiry rather than deleted at
 * once, because reuse detection works by finding a revoked row - see
 * auth/tokenService.js.
 */
function startHousekeeping() {
  const runOnce = async () => {
    try {
      const tokens = await pruneExpiredTokens();
      const attempts = await pruneAttempts();
      if (tokens || attempts) {
        console.log(`[housekeeping] pruned ${tokens} token row(s), ${attempts} login-attempt row(s)`);
      }
    } catch (err) {
      console.warn('[housekeeping] prune failed:', err.message);
    }
  };
  void runOnce();
  // Unref'd so it never holds the process open on shutdown.
  setInterval(runOnce, 6 * 60 * 60 * 1000).unref();
}

async function start() {
  await bootstrapRbac();
  await verifyEmailTransport();
  startHousekeeping();

  app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
    console.log(`Application URL (used in email links): ${APPLICATION_URL}`);
  });
}

/*
 * Last-resort logging for a fatal error.
 *
 * Node's default for an unhandled rejection or an uncaught exception is to
 * print and exit, which is the right behaviour - a process in an unknown state
 * should not keep serving. What it is not is diagnosable when the output goes
 * somewhere nobody is watching: the symptom is "the backend stopped", with an
 * empty log and no stack.
 *
 * These change nothing about the outcome. They make the reason survive it.
 */
function die(kind, err) {
  const detail = err instanceof Error ? err.stack || err.message : JSON.stringify(err);
  console.error(`[fatal] ${kind}: ${detail}`);
  // Flushed before exiting: stderr to a pipe is asynchronous on some platforms,
  // and exiting immediately is how the stack gets lost in the first place.
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 100).unref();
}

process.on('unhandledRejection', (err) => die('unhandled promise rejection', err));
process.on('uncaughtException', (err) => die('uncaught exception', err));

// Not errors, but worth a line: without one, a stop looks identical to a crash.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[shutdown] received ${signal}`);
    process.exit(0);
  });
}

start().catch((err) => {
  console.error('[startup] failed:', err.stack || err.message);
  process.exit(1);
});
