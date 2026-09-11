const path = require('path');
const express = require('express');
const cors = require('cors');
const { DIST_DIR } = require('../config/env');
const apiRoutes = require('./routes');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api', apiRoutes);

// Frontend build output, with SPA fallback for client-side routes.
app.use(express.static(DIST_DIR));
app.get('{*splat}', (req, res) => {
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
