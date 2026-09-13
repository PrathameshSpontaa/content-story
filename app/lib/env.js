// Loads secrets for local development from the project-root .env.local (never committed).
// On Render, the same names come from the service's environment group instead.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
let loaded = false;

export function loadEnv() {
  if (loaded) return;
  loaded = true;
  // Only local secret files are read here; the bundler must not try to trace these paths.
  for (const file of [join(/*turbopackIgnore: true*/ PROJECT_ROOT, '.env.local'), join(/*turbopackIgnore: true*/ PROJECT_ROOT, 'app', '.env.local')]) {
    if (existsSync(/*turbopackIgnore: true*/ file)) process.loadEnvFile(/*turbopackIgnore: true*/ file);
  }
}

export function requireEnv(name) {
  loadEnv();
  const value = (process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is not set. Add it to .env.local for development or to the Render environment group.`);
  return value;
}
