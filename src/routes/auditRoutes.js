const express = require('express');
const fs = require('fs');
const readline = require('readline');
const { ok, fail } = require('../api/response');
const { AUDIT_FILE } = require('../auth/auditService');
const {
  requireRbac,
  requireAuth,
  requirePasswordCurrent,
} = require('../middleware/auth');

/**
 * Audit log inspection for the platform owner.
 *
 * Reads append-only entries from the audit file and returns the most recent
 * entries as structured JSON objects. Access is restricted strictly to platform
 * accounts.
 */
const router = express.Router();

router.use(requireRbac, requireAuth, requirePasswordCurrent);

function requirePlatform(req, res, next) {
  if (!req.actor || !req.actor.isPlatform) {
    return next(fail('TENANT_ACCESS_DENIED', 'Only platform administrators can access audit records.'));
  }
  next();
}

router.use(requirePlatform);

router.get('/', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);

  if (!fs.existsSync(AUDIT_FILE)) {
    return ok(res, []);
  }

  const entries = [];
  const fileStream = fs.createReadStream(AUDIT_FILE, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Skip any corrupted line
    }
  }

  // Reverse so newest entries are first, then slice up to limit
  entries.reverse();
  const result = entries.slice(0, limit);

  ok(res, result);
});

module.exports = router;
