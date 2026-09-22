const express = require('express');
const fs = require('fs');
const readline = require('readline');
const { ok } = require('../api/response');
const { AUDIT_FILE } = require('../auth/auditService');

/**
 * Audit log inspection for the platform owner.
 *
 * Reads append-only entries from the audit file and returns the most recent
 * ones as structured JSON.
 *
 * This router declares no guards of its own. It is mounted only inside
 * /api/platform, which already applies requireRbac, requireAuth,
 * requirePasswordCurrent and requirePlatform to everything below it - and it
 * used to carry a second, local copy of the platform check. Two guards enforcing
 * the same rule is how one of them gets relaxed later without the other, so the
 * mount is now the single place that decides who reaches this.
 */
const router = express.Router();

// GET /api/platform/audit - the most recent audit entries, newest first
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
