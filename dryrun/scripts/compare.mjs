// Side-by-side of the Claude run (data/) and the Gemini run (data-gemini/) on the same posts.
// Usage: node scripts/compare.mjs → out-gemini/compare.html
import { join } from 'node:path';
import { PLATFORM_NAMES as P, ROOT, listJson, readJson, writeText } from './lib.mjs';

const RUNS = {
  claude: { label: 'Claude', dir: join(ROOT, 'data'), pages: '../out' },
  gemini: { label: 'Gemini', dir: join(ROOT, 'data-gemini'), pages: '.' },
};
const MATCH_AT = 0.25;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
const words = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean).length;

function loadRun({ dir }) {
  const read = (...parts) => readJson(join(dir, ...parts), null);
  const all = (sub) => listJson(join(dir, sub)).map((f) => readJson(f));
  const stories = read('stories.json') ?? { stories: [], unassigned: [], uncertain: [] };
  const per = new Map(
    stories.stories.map((s) => [
      s.story_id,
      {
        story: s,
        narrative: read('narrative', `${s.story_id}.json`),
        stats: read('stats', `${s.story_id}.json`),
        written: read('written', `${s.story_id}.json`),
        lens: read('lens', `${s.story_id}.json`),
        edit: read('edit', `${s.story_id}.json`),
        verify: read('verify', `${s.story_id}.json`),
      },
    ]),
  );
  const costLogs = listJson(join(dir, 'ai_cost'));
  const costRows = costLogs.flatMap((f) => readJson(f));
  return {
    stories,
    per,
    cards: all('cards'),
    groups: all('groups'),
    cost: costRows.reduce((s, r) => s + (r.usd ?? 0), 0),
    costByStep: costRows.reduce((m, r) => ((m[r.step] = (m[r.step] ?? 0) + (r.usd ?? 0)), m), {}),
    tokens: costRows.reduce((s, r) => s + r.input_tokens + r.output_tokens, 0),
    metered: costLogs.length > 0,
  };
}

const runs = { claude: loadRun(RUNS.claude), gemini: loadRun(RUNS.gemini) };

function metrics(run) {
  const claims = run.cards.flatMap((c) => c.claims ?? []);
  const groups = run.groups.flatMap((g) => g.groups ?? []);
  const written = [...run.per.values()].filter((p) => p.written);
  const checked = [...run.per.values()].filter((p) => p.verify);
  const headlines = [...run.per.values()].map((p) => p.edit?.headline ?? p.written?.headline).filter(Boolean);
  return [
    ['Story cards', run.cards.length],
    ['Marked newsworthy', run.cards.filter((c) => c.newsworthy).length],
    ['Claims with a verified quote', `${claims.filter((c) => c.quote).length} of ${claims.length}`],
    ['Posts with comment groups', run.groups.length],
    ['Comment groups', groups.length],
    ['Comments grouped / dropped as noise', `${groups.reduce((s, g) => s + g.comment_ids.length, 0)} / ${run.groups.reduce((s, g) => s + (g.dropped?.length ?? 0), 0)}`],
    ['Stories formed', run.stories.stories.length],
    ['Newsworthy posts in no story', (run.stories.unassigned ?? []).length],
    ['Stories fully written', written.length],
    ['Stories passing all checks', `${checked.filter((p) => p.verify.pass).length} of ${checked.length}`],
    ['Check warnings', checked.reduce((s, p) => s + p.verify.warnings.length, 0)],
    ['Average headline length', headlines.length ? `${(headlines.reduce((s, h) => s + words(h), 0) / headlines.length).toFixed(1)} words` : '–'],
    ['AI cost', run.metered ? `$${run.cost.toFixed(3)} (${Math.round(run.tokens / 1000)}k tokens)` : 'not metered (ran as Claude agents)'],
  ];
}

// Do the two runs read the same post the same way?
const cardByPost = (run) => new Map(run.cards.map((c) => [c.post_id, c]));
const cardsA = cardByPost(runs.claude);
const cardsB = cardByPost(runs.gemini);
const shared = [...cardsA.keys()].filter((id) => cardsB.has(id));
const agree = (key) => shared.filter((id) => cardsA.get(id)[key] === cardsB.get(id)[key]).length;

const jaccard = (a, b) => {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / (A.size + B.size - inter || 1);
};
const claudeStories = [...runs.claude.per.values()];
const geminiStories = [...runs.gemini.per.values()];
const pairs = claudeStories.map((a) => {
  const best = geminiStories
    .map((b) => ({ b, score: jaccard(a.story.post_ids, b.story.post_ids) }))
    .sort((x, y) => y.score - x.score)[0];
  return best && best.score >= MATCH_AT ? { a, b: best.b, score: best.score } : { a, b: null, score: best?.score ?? 0 };
});
const matchedB = new Set(pairs.filter((p) => p.b).map((p) => p.b.story.story_id));
const onlyGemini = geminiStories.filter((b) => !matchedB.has(b.story.story_id));

function side(entry, key) {
  if (!entry) return `<div class="side empty">No matching ${esc(RUNS[key].label)} story</div>`;
  const { story, narrative, stats, written, edit, verify } = entry;
  const headline = edit?.headline ?? written?.headline ?? story.working_title;
  const strip = (edit?.platform_strip ?? []).map((s) => `<li><b>${esc(P[s.platform] ?? s.platform)}</b>${esc(s.gist)}</li>`).join('');
  const angles = (narrative?.angles ?? []).map((a) => `<li>${esc(a.title)}</li>`).join('');
  const status = !written ? 'not written' : !verify ? 'not checked' : verify.pass ? `checks pass${verify.warnings.length ? ` · ${verify.warnings.length} warnings` : ''}` : `checks fail · ${verify.errors.length} errors`;
  return `<div class="side">
    <p class="eyebrow">${esc(RUNS[key].label)} · ${esc(story.story_id)} · ${story.post_ids.length} posts${stats ? ` · heat ${stats.heat}` : ''}</p>
    <h3>${esc(headline)}</h3>
    ${edit?.dek ? `<p class="dek">${esc(edit.dek)}</p>` : ''}
    <p class="meta">Main character: <b>${esc(narrative?.main_character?.name ?? '–')}</b></p>
    ${angles ? `<p class="lbl">Angles</p><ul class="angles">${angles}</ul>` : ''}
    ${strip ? `<p class="lbl">Platforms</p><ul class="strip">${strip}</ul>` : ''}
    <p class="meta ${verify && !verify.pass ? 'bad' : ''}">${esc(status)}</p>
    ${written ? `<a href="${RUNS[key].pages}/${esc(story.story_id)}.html">Open the ${esc(RUNS[key].label)} page →</a>` : ''}
  </div>`;
}

const summaryRows = metrics(runs.claude)
  .map(([name, a], i) => `<tr><td>${esc(name)}</td><td>${esc(a)}</td><td>${esc(metrics(runs.gemini)[i][1])}</td></tr>`)
  .join('');
const stepCosts = Object.entries(runs.gemini.costByStep)
  .map(([step, usd]) => `<span>${esc(step)} $${usd.toFixed(3)}</span>`)
  .join('');

const pairHtml = pairs
  .map((p) => `<section class="pair">${side(p.a, 'claude')}<div class="overlap"><b>${Math.round(p.score * 100)}%</b><span>same posts</span></div>${side(p.b, 'gemini')}</section>`)
  .join('');
const onlyGeminiHtml = onlyGemini.map((b) => `<section class="pair">${side(null, 'claude')}<div class="overlap"><b>new</b><span>Gemini only</span></div>${side(b, 'gemini')}</section>`).join('');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Claude vs Gemini</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;600;700;800&family=Newsreader:opsz,wght@6..72,400&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
:root{--ground:#EDF0F3;--panel:#FAFBFC;--ink:#141B24;--ink-2:#4F5B69;--ink-3:#7C8794;--rule:#CAD2DB;--cold:#2D5BD2;--hot:#D6461A;--mono:"JetBrains Mono",ui-monospace,Consolas,monospace;--serif:"Newsreader",Georgia,serif}
@media (prefers-color-scheme:dark){:root{--ground:#0E1319;--panel:#151C25;--ink:#E3E8EE;--ink-2:#A1ACB9;--ink-3:#77828F;--rule:#2A3441;--cold:#739DFF;--hot:#FF7B4F}}
*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.5 "Schibsted Grotesk","Segoe UI",system-ui,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px}
h1{font-size:38px;letter-spacing:-.02em;margin:0}h2{font-family:var(--mono);font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);margin:32px 0 12px;font-weight:500}
.lede{font-family:var(--serif);font-size:17px;color:var(--ink-2);max-width:78ch;margin:8px 0 0}
table{border-collapse:collapse;width:100%;background:var(--panel);border:1px solid var(--rule);border-radius:6px;overflow:hidden;font-size:14px}
th,td{padding:9px 14px;border-bottom:1px solid var(--rule);text-align:left}th{font-family:var(--mono);font-size:11px;color:var(--ink-3);font-weight:500}
td:not(:first-child){font-family:var(--mono);font-size:13px;font-variant-numeric:tabular-nums}
.costs{display:flex;flex-wrap:wrap;gap:6px 16px;font-family:var(--mono);font-size:12px;color:var(--ink-2);margin-top:10px}
.pair{display:grid;grid-template-columns:minmax(0,1fr) 84px minmax(0,1fr);gap:12px;margin-bottom:12px}
.side{background:var(--panel);border:1px solid var(--rule);border-radius:6px;padding:14px 16px;display:flex;flex-direction:column;gap:6px}
.side.empty{color:var(--ink-3);font-family:var(--mono);font-size:12px;justify-content:center;align-items:center}
.eyebrow{margin:0;font-family:var(--mono);font-size:11px;color:var(--ink-3)}
h3{margin:0;font-size:18px;line-height:1.25}
.dek{margin:0;font-family:var(--serif);font-size:15px;color:var(--ink-2)}
.meta{margin:0;font-size:13px;color:var(--ink-2)}.bad{color:var(--hot)}
.lbl{margin:4px 0 0;font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}
ul{margin:0;padding-left:18px;font-size:13.5px}
ul.strip{list-style:none;padding:0;display:grid;gap:3px}ul.strip li{display:grid;grid-template-columns:78px 1fr;gap:8px}
ul.strip b{font-family:var(--mono);font-size:10.5px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.06em}
.side a{font-size:13px;color:var(--cold);margin-top:auto}
.overlap{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.overlap b{font-size:22px;font-weight:800}.overlap span{font-family:var(--mono);font-size:10px;color:var(--ink-3)}
@media (max-width:860px){.pair{grid-template-columns:1fr}.overlap{flex-direction:row;gap:8px}}
</style></head><body><div class="wrap">
<h1>Claude vs Gemini on the same week</h1>
<p class="lede">Same 188 posts, same 1,137 comments, same prompts, same code checks. The Claude run also had two story merges and a reaction re-map done by hand during review; the Gemini run is straight through with the improved prompts.</p>
<h2>Run summary</h2>
<table><thead><tr><th>Measure</th><th>Claude</th><th>Gemini</th></tr></thead><tbody>${summaryRows}</tbody></table>
${stepCosts ? `<div class="costs">Gemini cost by step: ${stepCosts}</div>` : ''}
<h2>Do they read posts the same way?</h2>
<table><tbody>
<tr><td>Posts with a card in both runs</td><td>${shared.length}</td></tr>
<tr><td>Same newsworthy decision</td><td>${pct(agree('newsworthy'), shared.length)}</td></tr>
<tr><td>Same post type</td><td>${pct(agree('type'), shared.length)}</td></tr>
<tr><td>Same category</td><td>${pct(agree('category'), shared.length)}</td></tr>
</tbody></table>
<h2>Stories side by side · matched by shared posts</h2>
${pairHtml}${onlyGeminiHtml}
</div></body></html>`;

writeText(join(ROOT, 'out-gemini', 'compare.html'), html);
console.log(`compare: ${pairs.filter((p) => p.b).length} matched stories, ${pairs.filter((p) => !p.b).length} Claude-only, ${onlyGemini.length} Gemini-only → out-gemini/compare.html`);
