'use strict';

// Run the POS in a normal browser without the Windows app (for development).
//   POS_SETTINGS=path/to/settings.json node server.js
// Settings default to ./data/settings.json, which git ignores.

const path = require('path');
const { SettingsStore } = require('./lib/settings');
const { createPosServer } = require('./lib/app');

const dataDir = process.env.POS_DATA || path.join(__dirname, 'data');
const store = new SettingsStore(process.env.POS_SETTINGS || path.join(dataDir, 'settings.json'));
const server = createPosServer({ store, dataDir });
const port = Number(process.env.PORT || 8787);
server.listen(port, '127.0.0.1', () => {
  console.log(`Brushbeater POS running at http://127.0.0.1:${port}`);
});
