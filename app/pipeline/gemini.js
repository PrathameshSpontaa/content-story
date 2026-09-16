// Gemini client for the pipeline: JSON output, retries with backoff, a cost_events row for every call,
// and a fake mode (PIPELINE_PROVIDER=fake) that answers from the dry-run fixtures so tests never pay.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import https from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../lib/db.js';
import { requireEnv } from '../lib/env.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';
// How long one call may take. The strong model can think for more than 5 minutes over a big
// grouping input, and Node's fetch gives up on any reply slower than that, so calls use node:https.
const REQUEST_TIMEOUT_MS = 12 * 60_000;
const PROMPTS = resolve(dirname(fileURLToPath(import.meta.url)), 'prompts');
const dryrunData = () => process.env.DRYRUN_DATA || 'D:/Projects/Codeamesh/POC/Content-Story/dryrun/data';

// USD per 1M tokens [input, output] from Google's pricing page, checked 2026-09-13.
// Output includes thinking tokens. Update when prices change.
export const PRICES = {
  'gemini-2.5-flash-lite': [0.1, 0.4],
  'gemini-2.5-flash': [0.3, 2.5],
  'gemini-3.5-flash-lite': [0.3, 2.5],
  'gemini-3.6-flash': [0.75, 3.75],
  'gemini-3.7-flash': [0.75, 3.75],
  'gemini-3.8-flash': [0.75, 3.75],
};

export const MODELS = {
  // gemini-2.5-flash-lite is closed to new API users (404), so the cheap tier starts at 3.5 Flash-Lite.
  cheap: () => process.env.GEMINI_CHEAP_MODEL || 'gemini-3.5-flash-lite',
  strong: () => process.env.GEMINI_STRONG_MODEL || 'gemini-3.8-flash',
};

export const isFake = () => process.env.PIPELINE_PROVIDER === 'fake';

// Starts the note appended to a user message when a step is re-run after failing a check.
export const RETRY_MARKER = 'Your previous answer failed these checks';

const prompts = new Map();
export function loadPrompt(name) {
  if (!prompts.has(name)) prompts.set(name, readFileSync(join(PROMPTS, `${name}.md`), 'utf8'));
  return prompts.get(name);
}

// Models sometimes wrap JSON in a code fence or add a BOM; accept both.
export function parseJsonLoose(raw, label = 'input') {
  let text = String(raw).replace(/^\uFEFF/, '').trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1];
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Bad JSON in ${label}: ${err.message}`);
  }
}

// One HTTPS call with no limit but REQUEST_TIMEOUT_MS, start to finish. A connection that fails or
// times out throws with status 'network'.
function httpsCall(url, { method = 'GET', headers = {}, body = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, reject) => {
    let timer;
    const fail = (err) => {
      clearTimeout(timer);
      const wrapped = new Error(`Gemini connection failed: ${err.message}`);
      wrapped.status = 'network';
      wrapped.code = err.code;
      reject(wrapped);
    };
    const req = https.request(url, { method, headers: body == null ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        clearTimeout(timer);
        resolvePromise({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', fail);
    });
    timer = setTimeout(() => req.destroy(Object.assign(new Error(`no reply after ${Math.round(timeoutMs / 1000)}s`), { code: 'ETIMEDOUT' })), timeoutMs);
    req.on('error', fail);
    req.end(body ?? undefined);
  });
}

async function request(method, path, body) {
  const res = await httpsCall(`${API}${path}`, {
    method,
    headers: { 'x-goog-api-key': requireEnv('GEMINI_API_KEY'), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : null,
  });
  const text = res.text;
  if (!res.ok) {
    const err = new Error(`Gemini ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    // Quota errors say how long to wait (RetryInfo.retryDelay, e.g. "38s").
    try {
      const details = JSON.parse(text).error?.details ?? [];
      const retry = details.find((d) => String(d['@type']).includes('RetryInfo'))?.retryDelay;
      if (retry) err.retryDelayMs = Math.ceil(parseFloat(retry) * 1000);
      // A used-up daily quota won't recover by retrying, and every retry counts as another request.
      const dailyQuota = details.flatMap((d) => (d.violations ?? []).map((v) => String(v.quotaId ?? ''))).find((id) => id.includes('PerDay'));
      if (dailyQuota) {
        err.dailyQuota = true;
        err.message = `Gemini daily request limit reached for this model (${dailyQuota}). Enable billing on the key's Google Cloud project, or wait for the daily reset.`;
      }
    } catch {
      // Not JSON; fall back to exponential backoff.
    }
    throw err;
  }
  return JSON.parse(text);
}

// The daily spend cap lives in lib/spend.js (written separately); the pipeline still loads without it.
let spendModule;
async function assertUnderDailyCap(provider) {
  if (spendModule === undefined) {
    try {
      spendModule = await import('../lib/spend.js');
    } catch (err) {
      if (err.code !== 'ERR_MODULE_NOT_FOUND' || !/spend\.js/.test(err.message)) throw err;
      spendModule = null;
    }
  }
  if (typeof spendModule?.assertUnderDailyCap === 'function') await spendModule.assertUnderDailyCap(provider);
}

async function recordCost({ model, step, label, runId, workspaceId, usage = {}, fake = false }) {
  const input = usage.promptTokenCount ?? 0;
  const output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  const price = PRICES[model];
  const usd = fake || !price ? 0 : (input * price[0] + output * price[1]) / 1e6;
  await pool.query(
    `insert into cost_events (provider, detail, run_id, workspace_id, usd, units) values ('gemini', $1, $2, $3, $4, $5::jsonb)`,
    [model, runId, workspaceId, usd, JSON.stringify({ input_tokens: input, output_tokens: output, step, label, ...(fake ? { fake: true } : {}) })],
  );
  return usd;
}

// ─── Fake mode: fixtures from the dry run stand in for the model ────────────

const FIXTURE_DIR = { cards: 'cards', groups: 'groups', builder: 'narrative', writer: 'written', lens: 'lens', edit: 'edit' };
const readFixture = (file) => (existsSync(file) ? parseJsonLoose(readFileSync(file, 'utf8'), file) : null);
const batchIndex = new Map();

// Batched steps (cards, groups) are answered per item by post_id: first from the Gemini batch outputs
// under ai_out/<step>/, then from the per-post files the Claude run left.
function fixtureByPost(step, postId) {
  if (!batchIndex.has(step)) {
    const map = new Map();
    const dir = join(dryrunData(), 'ai_out', step);
    if (existsSync(dir)) {
      for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        const batch = readFixture(join(dir, f));
        if (Array.isArray(batch)) for (const item of batch) if (item?.post_id) map.set(item.post_id, item);
      }
    }
    batchIndex.set(step, map);
  }
  return batchIndex.get(step).get(postId) ?? readFixture(join(dryrunData(), FIXTURE_DIR[step] ?? step, `${postId}.json`));
}

function fakeAnswer({ step, label, user }) {
  const batch = user.match(/The input is a JSON array of (\d+) items/);
  if (batch) {
    const start = user.indexOf('Input:\n');
    const items = parseJsonLoose(user.slice(start + 7), `${step}/${label} batched input`);
    return items.map((item) => {
      const postId = item?.post_id ?? item?.post?.post_id;
      const out = fixtureByPost(step, postId);
      if (!out) throw new Error(`fake mode: no ${step} fixture for post ${postId} under ${dryrunData()}`);
      return out;
    });
  }
  // PIPELINE_FIXTURE_OVERLAY (tests) is read first: <overlay>/<step>/<label>.json, and for a re-run
  // after failed checks <label>.retry.json when it exists.
  const overlay = process.env.PIPELINE_FIXTURE_OVERLAY;
  const overlayFiles = overlay
    ? [...(user.includes(RETRY_MARKER) ? [join(overlay, step, `${label}.retry.json`)] : []), join(overlay, step, `${label}.json`)]
    : [];
  const candidates = [
    ...overlayFiles,
    ...(step === 'grouping'
      ? [join(dryrunData(), 'ai_out', step, `${label}.json`), join(dryrunData(), 'stories.json')]
      : [join(dryrunData(), 'ai_out', step, `${label}.json`), join(dryrunData(), FIXTURE_DIR[step] ?? step, `${label}.json`)]),
  ];
  for (const file of candidates) {
    const out = readFixture(file);
    if (out) return out;
  }
  throw new Error(`fake mode: no fixture for ${step}/${label} (looked in ${candidates.join(', ')})`);
}

// Sends one prompt and returns the parsed JSON. Rate limits, server errors, dropped connections, empty
// replies and broken JSON are retried with backoff (a timed-out call once, since each one is long);
// every call, paid or fake, leaves a cost_events row.
export async function generateJson({ model, system, user, step, label, runId = null, workspaceId = null, maxOutputTokens = 32768 }) {
  if (isFake()) {
    const out = fakeAnswer({ step, label, user });
    await recordCost({ model, step, label, runId, workspaceId, fake: true });
    return out;
  }
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens },
  };
  for (let attempt = 1; ; attempt += 1) {
    try {
      await assertUnderDailyCap('gemini');
      const data = await request('POST', `/models/${model}:generateContent`, body);
      const candidate = data.candidates?.[0];
      await recordCost({ model, step, label, runId, workspaceId, usage: data.usageMetadata });
      const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (!text) {
        const err = new Error(`empty reply (finishReason ${candidate?.finishReason ?? 'none'})`);
        err.status = 'empty';
        throw err;
      }
      return parseJsonLoose(text, `${step}/${label}`);
    } catch (err) {
      const network = err.status === 'network' && (err.code !== 'ETIMEDOUT' || attempt < 2);
      const retryable =
        !err.dailyQuota && (err.status === 429 || (typeof err.status === 'number' && err.status >= 500) || err.status === 'empty' || network || /Bad JSON/.test(err.message));
      if (!retryable || attempt >= 6) throw err;
      const waitMs = Math.min(120_000, Math.max(err.retryDelayMs ?? 0, 2 ** attempt * 2000));
      console.log(`  [${step}/${label}] ${err.message.replace(/\s+/g, ' ').slice(0, 160)}, retry ${attempt} in ${waitMs / 1000}s`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
