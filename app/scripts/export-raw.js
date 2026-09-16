// Archives raw Apify captures and cost events older than N days to gzip files, and (only with
// --delete) drops the archived payloads from the database to keep it small.
//
// Usage:  node scripts/export-raw.js [days] [--delete]         (default: 30 days; 0 = everything)
//         RAW_ARCHIVE_DIR=/var/archive node scripts/export-raw.js 30 --delete
//
// Output, one line of JSON per row (gzip):
//   $RAW_ARCHIVE_DIR/raw-captures-YYYY-MM-DD.jsonl.gz      raw_captures rows with their payload
//   $RAW_ARCHIVE_DIR/cost-events-YYYY-MM-DD.jsonl.gz       cost_events rows (never deleted)
//
// --delete nulls `payload` on the raw_captures rows that were written and sets storage_path to
// `archive:<file name>` so the row still says where its items went. It refuses to run unless
// RAW_ARCHIVE_DIR is set explicitly, so a typo cannot delete into ./archive by accident.
// Without --delete this script only reads.
import { createWriteStream, mkdirSync, renameSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { pool } from '../lib/db.js';
import { requireEnv } from '../lib/env.js';

requireEnv('DATABASE_URL');

const args = process.argv.slice(2);
const doDelete = args.includes('--delete');
const days = Number(args.find((a) => /^\d+$/.test(a)) ?? 30);
if (!Number.isInteger(days) || days < 0) {
  console.error('days must be a whole number (0 exports everything)');
  process.exit(2);
}
if (doDelete && !(process.env.RAW_ARCHIVE_DIR ?? '').trim()) {
  console.error('--delete needs RAW_ARCHIVE_DIR set explicitly (the default ./archive is not accepted when deleting).');
  process.exit(2);
}
const archiveDir = resolve((process.env.RAW_ARCHIVE_DIR ?? '').trim() || './archive');
mkdirSync(archiveDir, { recursive: true });

const today = new Date().toISOString().slice(0, 10);
const BATCH = 200;

async function hasColumn(table, column) {
  const { rows } = await pool.query(
    `select 1 from information_schema.columns where table_schema = current_schema() and table_name = $1 and column_name = $2`,
    [table, column],
  );
  return rows.length > 0;
}

// Reads `sql` in keyset batches (ordered by id) and writes each row as one JSON line into a
// gzip file. Returns the ids written and the final file path. Writes to a .part file first so a
// half-written archive is never mistaken for a complete one.
async function exportRows(fileBase, sql, params) {
  const file = join(archiveDir, `${fileBase}-${today}.jsonl.gz`);
  const part = `${file}.part`;
  const ids = [];
  async function* lines() {
    let lastId = null;
    for (;;) {
      const { rows } = await pool.query(sql, [...params, lastId, BATCH]);
      if (rows.length === 0) return;
      for (const row of rows) {
        ids.push(row.id);
        yield `${JSON.stringify(row)}\n`;
      }
      lastId = rows[rows.length - 1].id;
    }
  }
  await pipeline(Readable.from(lines()), createGzip({ level: 6 }), createWriteStream(part));
  renameSync(part, file);
  return { file, ids, bytes: statSync(file).size };
}

const cutoff = `now() - make_interval(days => $1::int)`;

// raw_captures: only rows that still carry a payload are worth archiving.
let captures = { file: null, ids: [], bytes: 0 };
if (await hasColumn('raw_captures', 'payload')) {
  captures = await exportRows(
    'raw-captures',
    `select id, run_id, platform, source, storage_path, items, usd, parser_version, captured_at, payload
       from raw_captures
      where captured_at < ${cutoff} and payload is not null and ($2::uuid is null or id > $2::uuid)
      order by id
      limit $3`,
    [days],
  );
  console.log(`raw_captures  ${captures.ids.length} rows older than ${days} days -> ${captures.file} (${captures.bytes} bytes)`);
} else {
  console.log('raw_captures  has no payload column yet (migration 0005 not applied); nothing to archive, nothing to delete.');
}

// cost_events: archived for the record, never deleted (they are small and feed the margin report).
const costs = await exportRows(
  'cost-events',
  `select id, provider, detail, run_id, workspace_id, usd, units, created_at
     from cost_events
    where created_at < ${cutoff} and ($2::bigint is null or id > $2::bigint)
    order by id
    limit $3`,
  [days],
);
console.log(`cost_events   ${costs.ids.length} rows older than ${days} days -> ${costs.file} (${costs.bytes} bytes)`);

if (doDelete && captures.ids.length > 0) {
  const { rowCount } = await pool.query(
    `update raw_captures set payload = null, storage_path = $2 where id = any($1::uuid[]) and payload is not null`,
    [captures.ids, `archive:${captures.file.split(/[\\/]/).pop()}`],
  );
  console.log(`deleted       payload nulled on ${rowCount} raw_captures rows (storage_path now points at the archive file)`);
} else if (doDelete) {
  console.log('deleted       nothing to delete');
} else {
  console.log('read-only     re-run with --delete (and RAW_ARCHIVE_DIR set) to null the archived payloads');
}

await pool.end();
