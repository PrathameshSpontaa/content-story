// Postgres connection shared by the app, the worker and scripts.
import pg from 'pg';
import { loadEnv } from './env.js';

loadEnv();

// Render requires TLS for connections from outside its network; set DATABASE_SSL=false for a local database.
// Kept on globalThis so Next.js hot reloads in development reuse one pool instead of opening new ones.
export const pool = (globalThis.__contentStoryPool ??= new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: Number(process.env.DATABASE_POOL_MAX) || 10,
}));

// Runs fn inside one transaction; rolls back on any error.
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
