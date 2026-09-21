/**
 * The warehouses the context layer knows about, and which of them can
 * actually be connected today.
 *
 * The unbuilt ones are listed rather than hidden, because the question this
 * screen answers is "can I bring my data in" and an empty page answers it
 * wrongly. They carry `status: 'planned'`, the UI shows them greyed out, and
 * the API refuses them - so nothing here can be mistaken for a working
 * integration.
 *
 * Adding one is a file under providers/, a `verify`/`listDatasets` pair, and
 * flipping `status` here. Nothing outside this folder changes.
 */

const STATUS = { available: 'available', planned: 'planned' };

/**
 * `credentials` describes the form the UI renders. It is data rather than a
 * component so a new provider does not need a new dialog - and so the backend
 * and the frontend cannot disagree about which fields exist.
 */
const CONNECTORS = [
  {
    id: 'domo',
    name: 'Domo',
    status: STATUS.available,
    description: 'Connect with a Domo access token and pick the datasets to build a context from.',
    docsUrl: 'https://domo-support.domo.com/s/article/360042934494',
    credentials: [
      {
        id: 'name',
        label: 'Connection name',
        type: 'text',
        placeholder: 'Domo — Sales',
        help: 'How this connection appears in your workspace.',
      },
      {
        id: 'host',
        label: 'Domo instance',
        type: 'text',
        placeholder: 'acme.domo.com',
        help: 'The address you sign in to. An access token is issued by one instance and is only valid there.',
      },
      {
        id: 'token',
        label: 'Developer access token',
        type: 'secret',
        placeholder: '',
        help: 'Domo → Admin → Authentication → Access tokens. Stored encrypted and never shown again.',
      },
    ],
  },
  {
    id: 'snowflake',
    name: 'Snowflake',
    status: STATUS.planned,
    description: 'Account, warehouse, database and a key-pair or password credential.',
    credentials: [],
  },
  {
    id: 'databricks',
    name: 'Databricks',
    status: STATUS.planned,
    description: 'Workspace URL, SQL warehouse and a personal access token.',
    credentials: [],
  },
  {
    id: 'bigquery',
    name: 'BigQuery',
    status: STATUS.planned,
    description: 'Project, dataset and a service-account key.',
    credentials: [],
  },
  {
    id: 'redshift',
    name: 'Amazon Redshift',
    status: STATUS.planned,
    description: 'Cluster endpoint, database and credentials.',
    credentials: [],
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    status: STATUS.planned,
    description: 'Host, database and a read-only role.',
    credentials: [],
  },
];

const BY_ID = new Map(CONNECTORS.map((c) => [c.id, c]));

/** The connector, or null. */
function findConnector(id) {
  return BY_ID.get(String(id || '').trim().toLowerCase()) || null;
}

module.exports = { STATUS, CONNECTORS, findConnector };
