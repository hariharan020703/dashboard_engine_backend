const { optional, ConfigError } = require('../../config/configError');

/**
 * How an MCP client reaches a PUBLISHED context: the read-side MCP server
 * (`Elze-backend/mcp-context-reader`), scoped to one connection.
 *
 * That server reads `context_objects` from the same database, and every tool it
 * exposes takes a `workspace_id` - which, in this deployment, IS the
 * connection id. So "connect this context to an MCP client" is: this URL, this
 * transport, this header, and this workspace id on every call.
 *
 * WHAT IS DELIBERATELY NOT SENT: the bearer token. The reader server
 * authenticates with ONE shared token (`MCP_READER_AUTH_TOKEN`) and takes the
 * workspace from the tool arguments, so whoever holds that token can read every
 * company's context by changing one argument. Handing it to a company
 * administrator in a browser would erase the tenant boundary. The response says
 * a token is required and where it comes from; the value stays with the
 * platform operator until the server issues per-workspace credentials.
 *
 * Configuration (backend/.env):
 *   CONTEXT_MCP_SERVER_URL      public URL of the reader, e.g. https://mcp.example.com/mcp
 *                               Unset = not deployed; the dialog says so.
 *   CONTEXT_MCP_AUTH_REQUIRED   true (default) when the reader enforces a bearer token.
 */

const SERVER_URL = optional('CONTEXT_MCP_SERVER_URL', '').trim() || null;
if (SERVER_URL && !/^https?:\/\//i.test(SERVER_URL)) {
  throw new ConfigError(`CONTEXT_MCP_SERVER_URL must be an http(s) URL (got "${SERVER_URL}")`);
}
const AUTH_REQUIRED_RAW = optional('CONTEXT_MCP_AUTH_REQUIRED', 'true').toLowerCase();
if (!['true', 'false'].includes(AUTH_REQUIRED_RAW)) {
  throw new ConfigError('CONTEXT_MCP_AUTH_REQUIRED must be true or false');
}
const AUTH_REQUIRED = AUTH_REQUIRED_RAW === 'true';

/** The name an MCP client lists the server under - stable per connection. */
function serverKey(connectionName) {
  const slug = String(connectionName || 'context')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `context-${slug || 'layer'}`;
}

/*
 * The reader tools that work against this deployment's database. The bundle,
 * data-source, PII and access-policy tools also exist on the server, but the
 * tables behind them are not present here (Elze-backend/CLAUDE.md, "Current
 * live DB state"), so listing them would advertise calls that fail.
 */
const TOOLS = [
  { name: 'list_context_objects', description: 'List the facts recorded for this connection, filterable by type.' },
  { name: 'get_context_object', description: 'Read one fact by id or qualified name.' },
  { name: 'search_context_objects', description: 'Semantic search over the facts (pgvector).' },
  { name: 'query_sql', description: 'Read-only SELECT / WITH over the context store, row-level scoped to the workspace.' },
];

/**
 * Everything an MCP client needs to reach one connection's published context.
 *
 * @param connection  { id, name }
 * @param published   the latest published version headline
 */
function mcpDetails(connection, published) {
  const key = serverKey(connection.name);
  const headers = AUTH_REQUIRED ? { Authorization: 'Bearer <MCP access token>' } : undefined;

  return {
    configured: Boolean(SERVER_URL),
    serverName: key,
    serverUrl: SERVER_URL,
    transport: 'streamable-http',
    workspaceId: connection.id,
    context: { name: published.name, version: published.label, publishedAt: published.publishedAt },
    auth: AUTH_REQUIRED
      ? {
          type: 'bearer',
          header: 'Authorization',
          format: 'Bearer <token>',
          // Where the value comes from, never the value itself - see above.
          source: 'Issued by your platform administrator (the MCP reader access token).',
        }
      : { type: 'none' },
    tools: TOOLS,
    // Ready to paste into an MCP client's server list (Claude Desktop, Claude
    // Code's .mcp.json and most others accept this shape).
    clientConfig: SERVER_URL
      ? {
          mcpServers: {
            [key]: {
              type: 'http',
              url: SERVER_URL,
              ...(headers ? { headers } : {}),
            },
          },
        }
      : null,
    // Every tool call must carry this, or the server has no workspace to scope to.
    usage: `Pass "workspace_id": "${connection.id}" on every tool call.`,
  };
}

module.exports = { mcpDetails, MCP_CONFIGURED: Boolean(SERVER_URL) };
