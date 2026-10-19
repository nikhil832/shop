import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connectDb } from './db.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const CLIENT_DIST = fileURLToPath(new URL('../../client/dist', import.meta.url));

const { client, db } = await connectDb(config.mongodbUri, config.mongodbDb);
const app = createApp({ db, client, config });

// In production, serve the built React app from the same server.
if (existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get('/{*splat}', (req, res) => res.sendFile('index.html', { root: CLIENT_DIST }));
}

const server = app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port} (database "${config.mongodbDb}")`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close();
    client.close().finally(() => process.exit(0));
  });
}
