import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Local settings (e.g. the Atlas connection string) live in server/.env, which is gitignored.
// Variables already set in the environment take precedence over the file.
export function loadConfig() {
  const envFile = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const config = {
    port: Number(process.env.PORT) || 4000,
    mongodbUri: process.env.MONGODB_URI,
    mongodbDb: process.env.MONGODB_DB || 'shop',
  };
  if (!config.mongodbUri) {
    console.error('MONGODB_URI is not set. Add it to server/.env (see server/.env.example), or run `npm run demo`.');
    process.exit(1);
  }
  return config;
}
