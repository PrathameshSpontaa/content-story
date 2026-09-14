// Sets each creator handle's profile photo from the dry run's raw data, and changes nothing else.
// Run it from a machine that has dryrun/data (it isn't in the repository).
// Usage: node scripts/backfill-avatars.js
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../lib/db.js';
import { requireEnv } from '../lib/env.js';
import { handleFor, readAvatars } from './dryrun-profiles.js';

requireEnv('DATABASE_URL');

const DRYRUN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dryrun');
const DATA = join(DRYRUN, 'data');
const creators = JSON.parse(readFileSync(join(DRYRUN, 'config', 'creators.json'), 'utf8')).creators;
const avatars = readAvatars(DATA, JSON.parse(readFileSync(join(DATA, 'posts.json'), 'utf8')));

let updated = 0;
try {
  for (const c of creators) {
    for (const [platform, account] of Object.entries(c.handles)) {
      const url = avatars.get(`${c.id}|${platform}`);
      if (!url) continue;
      const { rowCount } = await pool.query('update creator_handles set avatar_url = $3 where platform = $1 and lower(handle) = lower($2)', [platform, handleFor(platform, account), url]);
      updated += rowCount;
    }
  }
  console.log(`profile photos set on ${updated} handles`);
} finally {
  await pool.end();
}
