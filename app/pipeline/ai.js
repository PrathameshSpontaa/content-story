// AI client for the pipeline: JSON output from OpenAI (the default) or Gemini, chosen by AI_PROVIDER,
// with retries and backoff, a cost_events row for every call, and a fake mode (PIPELINE_PROVIDER=fake)
// that answers from the dry-run fixtures so tests never pay.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../lib/db.js';
import { aiProvider, requireEnv } from '../lib/env.js';

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
// OPENAI_BASE_URL points the client at a stand-in server in tests.
const openaiApi = () => (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
// How long one call may take. The strong model can think for more than 5 minutes over a big
// grouping input, and Node's fetch gives up on any reply slower than that, so calls use node:https.
const REQUEST_TIMEOUT_MS = 12 * 60_000;
// OpenAI counts reasoning tokens against max_output_tokens, so calls get this much room on top of the answer.
const OPENAI_REASONING_ROOM = 32768;
const PROMPTS = resolve(dirname(fileURLToPath(import.meta.url)), 'prompts');
const dryrunData = () => process.env.DRYRUN_DATA || 'D:/Projects/Codeamesh/POC/Content-Story/dryrun/data';

// USD per 1M tokens [input, output, cached input] from the providers' pricing pages, checked 2026-09-17.
// Output includes thinking (reasoning) tokens. Gemini calls are priced without cached input. Update when
// prices change; a model missing here is recorded at $0 and escapes the daily cap.
export const PRICES = {
  'gpt-5.6-sol': [4, 20, 0.4],
  'gpt-5.6-terra': [2, 12, 0.2],
  'gpt-5.6-luna': [0.2, 1.2, 0.02],
  'gpt-5.4-mini': [0.75, 4.5, 0.075],
  'gpt-5.4-nano': [0.2, 1.25, 0.02],
  'gpt-5-mini': [0.25, 2, 0.025],
  'gpt-5-nano': [0.05, 0.4, 0.005],
  'gemini-2.5-flash-lite': [0.1, 0.4],
  'gemini-2.5-flash': [0.3, 2.5],
  'gemini-3.5-flash-lite': [0.3, 2.5],
  'gemini-3.6-flash': [0.75, 3.75],
  'gemini-3.7-flash': [0.75, 3.75],
  'gemini-3.8-flash': [0.75, 3.75],
};

// One OpenAI web search call on a reasoning model; the search results' tokens are billed as input.
const WEB_SEARCH_USD = 0.01;

// Cheap: cards and comment groups. Strong: grouping, narrative, writing, lens and the AI editor.
// Override with OPENAI_CHEAP_MODEL / OPENAI_STRONG_MODEL (or the GEMINI_ ones when AI_PROVIDER=gemini).
const DEFAULT_MODELS = {
  openai: { cheap: 'gpt-5.6-luna', strong: 'gpt-5.4-mini' },
  // gemini-2.5-flash-lite is closed to new API users (404), so the cheap tier starts at 3.5 Flash-Lite.
  gemini: { cheap: 'gemini-3.5-flash-lite', strong: 'gemini-3.8-flash' },
};
const modelFor = (tier) => process.env[`${aiProvider().toUpperCase()}_${tier.toUpperCase()}_MODEL`] || DEFAULT_MODELS[aiProvider()][tier];

export const MODELS = {
  cheap: () => modelFor('cheap'),
  strong: () => modelFor('strong'),
};

// OpenAI reasoning effort per tier: OPENAI_CHEAP_EFFORT (default low) and OPENAI_STRONG_EFFORT (default medium).
const openaiEffort = (model) =>
  model === MODELS.cheap() ? process.env.OPENAI_CHEAP_EFFORT || 'low' : process.env.OPENAI_STRONG_EFFORT || 'medium';

export const isFake = () => process.env.PIPELINE_PROVIDER === 'fake';

// Starts the note appended to a user message when a step is re-run after failing a check.
export const RETRY_MARKER = 'Your previous answer failed these checks';

const prompts = new Map();
export function loadPrompt(name) {
  if (!prompts.has(name)) prompts.set(name, readFileSync(join(PROMPTS, `${name}.md`), 'utf8'));
  return prompts.get(name);
}

// Models sometimes wrap JSON in a code fence, add a BOM, or (answering after a web search, without JSON
// mode) put a sentence around it; accept all three.
export function parseJsonLoose(raw, label = 'input') {
  let text = String(raw).replace(/^\uFEFF/, '').trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/) ?? text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) text = fence[1];
  try {
    return JSON.parse(text);
  } catch (err) {
    const start = text.search(/[{[]/);
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (start > 0 || (start === 0 && end < text.length - 1)) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // Fall through to the original error.
      }
    }
    throw new Error(`Bad JSON in ${label}: ${err.message}`);
  }
}

// One HTTP(S) call with no limit but REQUEST_TIMEOUT_MS, start to finish. A connection that fails or
// times out throws with status 'network'.
function httpsCall(url, { method = 'GET', headers = {}, body = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, reject) => {
    let timer;
    const fail = (err) => {
      clearTimeout(timer);
      const wrapped = new Error(`${aiProvider()} connection failed: ${err.message}`);
      wrapped.status = 'network';
      wrapped.code = err.code;
      reject(wrapped);
    };
    const client = url.startsWith('http://') ? http : https;
    const req = client.request(url, { method, headers: body == null ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        clearTimeout(timer);
        resolvePromise({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', fail);
    });
    timer = setTimeout(() => req.destroy(Object.assign(new Error(`no reply after ${Math.round(timeoutMs / 1000)}s`), { code: 'ETIMEDOUT' })), timeoutMs);
    req.on('error', fail);
    req.end(body ?? undefined);
  });
}

// ─── Providers: each returns { text, usage: { input, cached, output }, finish, incomplete } ──

// With webSearch the model grounds its answer in Google Search; JSON mime type can't be combined with
// that, so the prompt asks for JSON instead.
async function callGemini({ model, system, user, maxOutputTokens, webSearch = false }) {
  const res = await httpsCall(`${GEMINI_API}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': requireEnv('GEMINI_API_KEY'), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      ...(webSearch ? { tools: [{ google_search: {} }] } : {}),
      generationConfig: { ...(webSearch ? {} : { responseMimeType: 'application/json' }), temperature: 0.2, maxOutputTokens },
    }),
  });
  if (!res.ok) {
    const err = new Error(`Gemini ${res.status}: ${res.text.slice(0, 400)}`);
    err.status = res.status;
    // Quota errors say how long to wait (RetryInfo.retryDelay, e.g. "38s").
    try {
      const details = JSON.parse(res.text).error?.details ?? [];
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
  const data = JSON.parse(res.text);
  const candidate = data.candidates?.[0];
  const usage = data.usageMetadata ?? {};
  return {
    text: (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join(''),
    usage: { input: usage.promptTokenCount ?? 0, cached: 0, output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0) },
    finish: `finishReason ${candidate?.finishReason ?? 'none'}`,
    incomplete: false,
  };
}

// The Responses API in JSON mode (the answer must be one JSON object). store: false keeps posts and
// comments out of OpenAI's 30-day response storage. With webSearch the model may search the web; JSON
// mode is left off then, and the prompt asks for JSON instead.
async function callOpenAI({ model, system, user, maxOutputTokens, webSearch = false, effort = null }) {
  const res = await httpsCall(`${openaiApi()}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${requireEnv('OPENAI_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      instructions: system,
      input: user,
      ...(webSearch ? { tools: [{ type: 'web_search' }] } : { text: { format: { type: 'json_object' } } }),
      reasoning: { effort: effort ?? openaiEffort(model) },
      max_output_tokens: maxOutputTokens + OPENAI_REASONING_ROOM,
      store: false,
    }),
  });
  if (!res.ok) {
    let detail = {};
    try {
      detail = JSON.parse(res.text).error ?? {};
    } catch {
      // Not JSON; the raw body goes in the message.
    }
    const err = new Error(`OpenAI ${res.status}: ${String(detail.message ?? res.text).slice(0, 400)}`);
    err.status = res.status;
    const waitMs = Number(res.headers['retry-after-ms']) || Number(res.headers['retry-after']) * 1000;
    if (waitMs > 0) err.retryDelayMs = waitMs;
    // Out of credits or over the project's budget: retrying won't help, and the run should stop.
    if (detail.code === 'insufficient_quota' || detail.type === 'insufficient_quota') {
      err.dailyQuota = true;
      err.message = 'OpenAI has no credit left for this API key (insufficient_quota). Add credits or raise the budget at platform.openai.com > Settings > Billing and Limits.';
    }
    throw err;
  }
  const data = JSON.parse(res.text);
  const usage = data.usage ?? {};
  const content = (data.output ?? []).filter((item) => item.type === 'message').flatMap((item) => item.content ?? []);
  const refusal = content.find((c) => c.type === 'refusal')?.refusal;
  return {
    text: content.filter((c) => c.type === 'output_text').map((c) => c.text ?? '').join(''),
    usage: {
      input: usage.input_tokens ?? 0,
      cached: usage.input_tokens_details?.cached_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      searches: (data.output ?? []).filter((item) => item.type === 'web_search_call').length,
    },
    finish: refusal ? `refusal: ${String(refusal).slice(0, 120)}` : `status ${data.status ?? 'none'}${data.incomplete_details?.reason ? ` (${data.incomplete_details.reason})` : ''}`,
    incomplete: data.status === 'incomplete',
  };
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

const unpriced = new Set();
async function recordCost({ provider, model, step, label, runId, workspaceId, usage = {}, fake = false }) {
  const { input = 0, cached = 0, output = 0, searches = 0 } = usage;
  const price = PRICES[model];
  if (!fake && !price && !unpriced.has(model)) {
    unpriced.add(model);
    console.log(`  [ai] no price for ${model} in pipeline/ai.js PRICES; its calls are recorded at $0 and don't count toward the daily cap`);
  }
  const tokens = fake || !price ? 0 : ((input - cached) * price[0] + cached * (price[2] ?? price[0]) + output * price[1]) / 1e6;
  const usd = tokens + (fake ? 0 : searches * WEB_SEARCH_USD);
  await pool.query(
    `insert into cost_events (provider, detail, run_id, workspace_id, usd, units) values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [provider, model, runId, workspaceId, usd, JSON.stringify({ input_tokens: input, ...(cached ? { cached_input_tokens: cached } : {}), output_tokens: output, ...(searches ? { web_searches: searches } : {}), step, label, ...(fake ? { fake: true } : {}) })],
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
// replies and broken JSON are retried with backoff (a timed-out or cut-off call once, since each one
// is long); every call, paid or fake, leaves a cost_events row. webSearch lets the model search the web
// (the channel finder); effort overrides the reasoning effort; maxAttempts caps retries for callers a
// person is waiting on.
export async function generateJson({ model, system, user, step, label, runId = null, workspaceId = null, maxOutputTokens = 32768, webSearch = false, effort = null, maxAttempts = 6 }) {
  const provider = aiProvider();
  if (isFake()) {
    const out = fakeAnswer({ step, label, user });
    await recordCost({ provider, model, step, label, runId, workspaceId, fake: true });
    return out;
  }
  const call = provider === 'openai' ? callOpenAI : callGemini;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await assertUnderDailyCap(provider);
      const reply = await call({ model, system, user, maxOutputTokens, webSearch, effort });
      await recordCost({ provider, model, step, label, runId, workspaceId, usage: reply.usage });
      if (reply.incomplete) {
        const err = new Error(`reply cut off (${reply.finish})`);
        err.status = 'incomplete';
        throw err;
      }
      if (!reply.text) {
        const err = new Error(`empty reply (${reply.finish})`);
        err.status = 'empty';
        throw err;
      }
      return parseJsonLoose(reply.text, `${step}/${label}`);
    } catch (err) {
      const network = err.status === 'network' && (err.code !== 'ETIMEDOUT' || attempt < 2);
      const retryable =
        !err.dailyQuota &&
        (err.status === 429 || (typeof err.status === 'number' && err.status >= 500) || err.status === 'empty' || (err.status === 'incomplete' && attempt < 2) || network || /Bad JSON/.test(err.message));
      if (!retryable || attempt >= maxAttempts) throw err;
      const waitMs = Math.min(120_000, Math.max(err.retryDelayMs ?? 0, 2 ** attempt * 2000));
      console.log(`  [${step}/${label}] ${err.message.replace(/\s+/g, ' ').slice(0, 160)}, retry ${attempt} in ${waitMs / 1000}s`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
