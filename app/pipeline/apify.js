// Runs one Apify actor, waits for it, keeps the raw items in raw_captures and the cost in
// cost_events. In fake mode (PIPELINE_PROVIDER=fake) the items come from the dry-run files instead.
import { randomUUID } from 'node:crypto';
import { pool } from '../lib/db.js';
import { requireEnv } from '../lib/env.js';
import { isFake, readRawFixture } from './fixtures.js';

const API = 'https://api.apify.com/v2';
const DONE = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${requireEnv('APIFY_TOKEN')}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Apify ${method} ${path.split('?')[0]} failed with ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

export async function whoAmI() {
  const { data } = await call('GET', '/users/me');
  return { username: data.username, plan: data.plan?.id ?? data.plan ?? 'unknown' };
}

// The daily spend cap lives in lib/spend.js; until that module exists the check is skipped.
async function assertUnderDailyCap(provider) {
  let spend;
  try {
    spend = await import('../lib/spend.js');
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') return;
    throw err;
  }
  if (typeof spend.assertUnderDailyCap === 'function') await spend.assertUnderDailyCap(provider);
}

// One row in raw_captures (the items themselves in payload) and one in cost_events.
async function record({ runId, workspaceId, platform, actor, items, usd, chargedEvents }) {
  const captureId = randomUUID();
  await pool.query(
    `insert into raw_captures (id, run_id, platform, source, storage_path, items, usd, payload)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [captureId, runId ?? null, platform, actor, `db:${captureId}`, items.length, usd ?? null, JSON.stringify(items)],
  );
  await pool.query(
    `insert into cost_events (provider, detail, run_id, workspace_id, usd, units) values ('apify', $1, $2, $3, $4, $5::jsonb)`,
    [actor, runId ?? null, workspaceId ?? null, usd ?? 0, JSON.stringify({ items: items.length, charged_events: chargedEvents ?? null })],
  );
  return captureId;
}

// Starts an actor and waits for it. maxTotalChargeUsd is the hard spending cap: Apify stops the
// run when it's reached. Returns { items, usd, captureId, status }.
export async function runActor({ actor, input, platform, label, maxTotalChargeUsd, timeoutMinutes = 25, runId = null, workspaceId = null, log = console.log }) {
  const tag = `${platform}/${label}`;

  if (isFake()) {
    const items = readRawFixture(platform, label);
    if (!items) log(`[${tag}] fake mode: no fixture at raw/${platform}/${label}.json, returning 0 items`);
    else log(`[${tag}] fake mode: ${items.length} items from the dry-run fixture (would run ${actor}, cap $${maxTotalChargeUsd})`);
    const captureId = await record({ runId, workspaceId, platform, actor, items: items ?? [], usd: 0, chargedEvents: { fake: 1 } });
    return { items: items ?? [], usd: 0, captureId, status: 'FAKE' };
  }

  await assertUnderDailyCap('apify');
  const query = maxTotalChargeUsd != null ? `?maxTotalChargeUsd=${maxTotalChargeUsd}` : '';
  const id = actor.replace('/', '~');

  let run = (await call('POST', `/actors/${id}/runs${query}`, input)).data;
  log(`[${tag}] started ${actor} (cap $${maxTotalChargeUsd})`);

  const deadline = Date.now() + timeoutMinutes * 60_000;
  let aborted = false;
  while (!DONE.has(run.status)) {
    if (!aborted && Date.now() > deadline) {
      log(`[${tag}] still running after ${timeoutMinutes} min, aborting and keeping what it collected`);
      await call('POST', `/actor-runs/${run.id}/abort`);
      aborted = true;
    }
    run = (await call('GET', `/actor-runs/${run.id}?waitForFinish=60`)).data;
  }

  const items = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await call('GET', `/datasets/${run.defaultDatasetId}/items?clean=true&format=json&offset=${offset}&limit=1000`);
    items.push(...page);
    if (page.length < 1000) break;
  }

  // Cost figures settle a few seconds after the run ends.
  await new Promise((r) => setTimeout(r, 10_000));
  run = (await call('GET', `/actor-runs/${run.id}`)).data;
  const usd = run.usageTotalUsd ?? null;

  const captureId = await record({ runId, workspaceId, platform, actor, items, usd, chargedEvents: run.chargedEventCounts ?? null });
  log(`[${tag}] ${run.status}: ${items.length} items, ${usd != null ? `$${usd.toFixed(3)}` : 'cost unknown'}`);
  return { items, usd, captureId, status: run.status };
}
