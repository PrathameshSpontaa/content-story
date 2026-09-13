// Gemini API client: JSON output, retries, and a cost line for every call.
import { join } from 'node:path';
import { DATA, loadEnv, parseJsonLoose, readJson, writeJson } from './lib.mjs';

const API = 'https://generativelanguage.googleapis.com/v1beta';

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

function apiKey() {
  loadEnv();
  const value = (process.env.GEMINI_API_KEY || '').trim();
  if (!value) throw new Error('GEMINI_API_KEY is empty. Paste your key into dryrun/.env.local, save, and run again.');
  return value;
}

async function request(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'x-goog-api-key': apiKey(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
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

export async function listModels() {
  const names = [];
  let pageToken = '';
  do {
    const page = await request('GET', `/models?pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`);
    for (const m of page.models ?? []) {
      if ((m.supportedGenerationMethods ?? []).includes('generateContent')) names.push(m.name.replace('models/', ''));
    }
    pageToken = page.nextPageToken ?? '';
  } while (pageToken);
  return names;
}

function logCost({ model, step, label, usage = {} }) {
  const input = usage.promptTokenCount ?? 0;
  const output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  const price = PRICES[model];
  // One log per step, so steps running in parallel processes never overwrite each other.
  const file = join(DATA, 'ai_cost', `${step}.json`);
  const log = readJson(file, []);
  log.push({
    at: new Date().toISOString(),
    provider: 'gemini',
    model,
    step,
    label,
    input_tokens: input,
    output_tokens: output,
    usd: price ? (input * price[0] + output * price[1]) / 1e6 : null,
  });
  writeJson(file, log);
}

// Sends one prompt and returns the parsed JSON. Rate limits, server errors,
// empty replies and broken JSON are retried with backoff; every paid call is logged.
export async function generateJson({ model, system, user, step, label, maxOutputTokens = 32768 }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens },
  };
  for (let attempt = 1; ; attempt += 1) {
    try {
      const data = await request('POST', `/models/${model}:generateContent`, body);
      const candidate = data.candidates?.[0];
      logCost({ model, step, label, usage: data.usageMetadata });
      const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (!text) {
        const err = new Error(`empty reply (finishReason ${candidate?.finishReason ?? 'none'})`);
        err.status = 'empty';
        throw err;
      }
      return parseJsonLoose(text, `${step}/${label}`);
    } catch (err) {
      const retryable =
        !err.dailyQuota && (err.status === 429 || (typeof err.status === 'number' && err.status >= 500) || err.status === 'empty' || /Bad JSON/.test(err.message));
      if (!retryable || attempt >= 6) throw err;
      const waitMs = Math.min(120_000, Math.max(err.retryDelayMs ?? 0, 2 ** attempt * 2000));
      console.log(`  [${step}/${label}] ${err.message.slice(0, 120)}, retry ${attempt} in ${waitMs / 1000}s`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
