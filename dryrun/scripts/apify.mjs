import { join } from 'node:path';
import { DATA, loadEnv, readJson, writeJson } from './lib.mjs';

const API = 'https://api.apify.com/v2';
const DONE = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

function token() {
  loadEnv();
  const value = (process.env.APIFY_TOKEN || '').trim();
  if (!value) throw new Error('APIFY_TOKEN is empty. Paste your token into dryrun/.env, save, and run again.');
  return value;
}

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
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

// Starts an actor, waits for it, saves every item to data/raw/<platform>/<label>.json
// and appends the run's cost to data/raw/cost_log.json.
// maxTotalChargeUsd is the hard spending cap: Apify stops the run when it's reached.
export async function runActor({ actor, input, platform, label, maxTotalChargeUsd, timeoutMinutes = 25 }) {
  const tag = `${platform}/${label}`;
  const query = maxTotalChargeUsd != null ? `?maxTotalChargeUsd=${maxTotalChargeUsd}` : '';
  const id = actor.replace('/', '~');

  let run = (await call('POST', `/actors/${id}/runs${query}`, input)).data;
  console.log(`[${tag}] started ${actor} (cap $${maxTotalChargeUsd})`);

  const deadline = Date.now() + timeoutMinutes * 60_000;
  let aborted = false;
  while (!DONE.has(run.status)) {
    if (!aborted && Date.now() > deadline) {
      console.log(`[${tag}] still running after ${timeoutMinutes} min, aborting and keeping what it collected`);
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
  writeJson(join(DATA, 'raw', platform, `${label}.json`), items);

  // Cost figures settle a few seconds after the run ends.
  await new Promise((r) => setTimeout(r, 10_000));
  run = (await call('GET', `/actor-runs/${run.id}`)).data;

  const logFile = join(DATA, 'raw', 'cost_log.json');
  const log = readJson(logFile, []);
  log.push({
    platform,
    label,
    actor,
    run_id: run.id,
    status: run.status,
    items: items.length,
    usd: run.usageTotalUsd ?? null,
    charged_events: run.chargedEventCounts ?? null,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
  });
  writeJson(logFile, log);

  const usd = run.usageTotalUsd != null ? `$${run.usageTotalUsd.toFixed(3)}` : 'cost unknown';
  console.log(`[${tag}] ${run.status}: ${items.length} items, ${usd}`);
  return { run, items };
}
