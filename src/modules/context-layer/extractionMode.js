const { optional, ConfigError } = require('../../config/configError');

/**
 * Which engine step 4 runs: the real extraction agent, or the demo generator.
 *
 *   agent - the context_layer_extractor agent on the ADK API (:8300). The
 *           browser calls that service directly; this backend is not involved.
 *   demo  - demoExtraction.js, in this process. No model is called.
 *
 * `demo` is TEMPORARY, for while the Anthropic credit behind the agent is
 * exhausted. Setting this back to `agent` (or removing it) is the whole switch:
 * the frontend reads the mode from GET /api/context/settings, so there is no
 * second flag to keep in step.
 */
const MODES = ['agent', 'demo'];

const EXTRACTION_MODE = optional('CONTEXT_EXTRACTION_MODE', 'agent').toLowerCase();
if (!MODES.includes(EXTRACTION_MODE)) {
  throw new ConfigError(
    `CONTEXT_EXTRACTION_MODE must be one of: ${MODES.join(', ')} (got "${EXTRACTION_MODE}")`
  );
}

module.exports = { EXTRACTION_MODE };
