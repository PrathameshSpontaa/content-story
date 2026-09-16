// The AI editor for the shared feed: judges whether a finished, checked story should be published, and
// whether two stories the split check paired are one story. The model judges; storybuild.js applies it.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from '../lib/db.js';
import { MODELS, generateJson, isFake, loadPrompt } from './gemini.js';
import { stripCites } from './verify.js';

export const EDITOR_DECISIONS = ['publish', 'hold', 'reject'];

const clamp01 = (value) => {
  const n = Number(value);
  return value == null || !Number.isFinite(n) ? null : Math.min(1, Math.max(0, n));
};
const oneLine = (value, max = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const iso = (value) => (value == null ? null : new Date(value).toISOString());

// Sends one judging prompt to the strong model. In fake mode an overlay fixture answers when the test
// wrote one (<overlay>/<step>/<label>.json); otherwise `fakeAnswer` does, with a $0 cost row like gemini.js.
async function judge({ step, prompt, input, label, runId, workspaceId, fakeAnswer }) {
  const model = MODELS.strong();
  const overlay = process.env.PIPELINE_FIXTURE_OVERLAY;
  if (isFake() && !(overlay && existsSync(join(overlay, step, `${label}.json`)))) {
    await pool.query(
      `insert into cost_events (provider, detail, run_id, workspace_id, usd, units) values ('gemini', $1, $2, $3, 0, $4::jsonb)`,
      [model, runId, workspaceId, JSON.stringify({ input_tokens: 0, output_tokens: 0, step, label, fake: true })],
    );
    return { out: fakeAnswer(), model };
  }
  const user = `Input:\n${JSON.stringify(input)}\n\nReturn only the JSON described under Output.`;
  const out = await generateJson({ model, system: loadPrompt(prompt), user, step, label, runId, workspaceId });
  if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error(`${step}/${label}: expected one JSON object`);
  return { out, model };
}

// Whether a story that passed its checks belongs in the shared feed. `label` names the fixture in fake
// mode (the story's plan ref); it defaults to the story id. Throws when the model gives no usable decision.
export async function reviewStory({ storyId, written, edit, stats, lens, checks, narrative, runId = null, log = console.log, label = null, workspaceId = null }) {
  const input = {
    headline: edit?.headline || written?.headline || '',
    dek: edit?.dek ?? '',
    main_character: narrative?.main_character?.name ?? null,
    category: stats?.category ?? null,
    narrative: (written?.narrative ?? []).map((s) => stripCites(s.sentence)),
    platform_takes: (lens?.platforms ?? []).map((p) => ({
      platform: p.platform, take: p.take, creators_say: stripCites(p.creators_say?.text), audience_says: stripCites(p.audience_says?.text),
    })),
    numbers: {
      posts: stats?.posts, sources: stats?.sources, creators: stats?.creators, platforms: stats?.platforms,
      comments: stats?.comments_counted, heat: stats?.heat, max_lift: stats?.max_lift,
    },
    check_warnings: (checks?.warnings ?? []).slice(0, 20),
  };
  const { out, model } = await judge({
    step: 'editor', prompt: '08_story_editor', input, label: label ?? storyId, runId, workspaceId,
    fakeAnswer: () => (checks?.pass ? { decision: 'publish', reason: 'Fake editor: the story passed its checks.', confidence: 0.9 } : { decision: 'hold', reason: 'Fake editor: the story failed its checks.', confidence: 0.9 }),
  });
  const decision = String(out.decision ?? '').trim().toLowerCase();
  if (!EDITOR_DECISIONS.includes(decision)) throw new Error(`editor/${label ?? storyId}: decision "${out.decision}" is not publish, hold or reject`);
  const verdict = { decision, reason: oneLine(out.reason) || 'no reason given', confidence: clamp01(out.confidence), model };
  log(`[editor] ${label ?? storyId}: ${verdict.decision}${verdict.confidence != null ? ` (${verdict.confidence})` : ''}: ${verdict.reason}`);
  return verdict;
}

// Whether two stories are one. `a` and `b` are { id, headline, dek, main_entity, entity, first_post_at,
// last_post_at, category, post_count, posts: [{ platform, published_at, about }] }, `a` the smaller id;
// the fake-mode fixture label is "<a.id>_<b.id>". `keep` names the story to keep, 'a' or 'b'.
export async function judgeSameStory({ a, b, runId = null, log = console.log, workspaceId = null }) {
  const side = (s) => ({
    headline: s.headline ?? '', dek: s.dek ?? '', main_entity: s.main_entity ?? null,
    first_post_at: iso(s.first_post_at), last_post_at: iso(s.last_post_at), category: s.category ?? null, post_count: s.post_count ?? s.posts?.length ?? 0,
    posts: (s.posts ?? []).slice(0, 8).map((p) => ({ platform: p.platform, published_at: iso(p.published_at), about: p.about ?? '' })),
  });
  const more = (a.post_count ?? 0) >= (b.post_count ?? 0) ? 'a' : 'b';
  const label = `${a.id}_${b.id}`;
  const { out, model } = await judge({
    step: 'same_story', prompt: '09_same_story', input: { a: side(a), b: side(b) }, label, runId, workspaceId,
    fakeAnswer: () => {
      const same = Boolean(a.entity ?? a.main_entity) && (a.entity ?? a.main_entity) === (b.entity ?? b.main_entity);
      return { same_story: same, keep: more, reason: `Fake judge: ${same ? 'same' : 'different'} main entity.`, confidence: 0.8 };
    },
  });
  if (typeof out.same_story !== 'boolean') throw new Error(`same_story/${label}: same_story is not true or false`);
  const keep = ['a', 'b'].includes(out.keep) ? out.keep : more;
  const verdict = { same_story: out.same_story, keep, reason: oneLine(out.reason) || 'no reason given', confidence: clamp01(out.confidence), model };
  log(`[editor] ${label}: ${verdict.same_story ? `same story, keep ${keep}` : 'different stories'}${verdict.confidence != null ? ` (${verdict.confidence})` : ''}: ${verdict.reason}`);
  return verdict;
}
