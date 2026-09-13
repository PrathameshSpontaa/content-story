// Applies database migrations in order, once each, and records them in schema_migrations.
// db/schema.sql is migration 0001; later changes go in db/migrations/0002_*.sql and onward.
// Usage: node scripts/migrate.js
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../lib/db.js';
import { requireEnv } from '../lib/env.js';

requireEnv('DATABASE_URL');

const DB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db');
const migrations = [{ name: '0001_init', file: join(DB_DIR, 'schema.sql') }];
const extraDir = join(DB_DIR, 'migrations');
if (existsSync(extraDir)) {
  for (const f of readdirSync(extraDir).filter((f) => f.endsWith('.sql')).sort()) migrations.push({ name: f.replace(/\.sql$/, ''), file: join(extraDir, f) });
}

const client = await pool.connect();
try {
  await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const { rows } = await client.query('select name from schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  for (const m of migrations) {
    if (applied.has(m.name)) {
      console.log(`skip   ${m.name} (already applied)`);
      continue;
    }
    await client.query('begin');
    try {
      await client.query(readFileSync(m.file, 'utf8'));
      await client.query('insert into schema_migrations (name) values ($1)', [m.name]);
      await client.query('commit');
      console.log(`apply  ${m.name}`);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`${m.name} failed: ${err.message}`);
    }
  }
} finally {
  client.release();
  await pool.end();
}
