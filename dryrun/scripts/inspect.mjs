// A browsable view of the intermediate results: every post with its story card and comment groups.
// Usage: node scripts/inspect.mjs → out/inspect.html
import { join } from 'node:path';
import { OUT, PLATFORM_NAMES as P, loadWorld, truncate, writeText } from './lib.mjs';

const { posts, commentById, cardByPost, groupsByPost } = loadWorld();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const n = (v) => (v == null ? '–' : Number(v).toLocaleString('en-US'));
const when = (iso) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const platforms = [...new Set(posts.map((p) => p.platform))];
const sorted = [...posts].sort((a, b) => platforms.indexOf(a.platform) - platforms.indexOf(b.platform) || Date.parse(b.published_at) - Date.parse(a.published_at));

const articles = sorted
  .map((p) => {
    const card = cardByPost.get(p.post_id);
    const groups = groupsByPost.get(p.post_id);
    const claims = (card?.claims ?? [])
      .map((c) => `<li>${esc(c.text)} <span class="muted">· ${esc(c.kind)} · ${esc(c.stance)} · about ${esc(c.about)}</span>${c.quote ? `<q>${esc(c.quote)}</q>` : ''}</li>`)
      .join('');
    const groupHtml = (groups?.groups ?? [])
      .map((g) => {
        const samples = g.sample_ids
          .map((id) => commentById.get(id))
          .filter(Boolean)
          .map((c) => `<li>${esc(truncate(c.text, 220))} <span class="muted">· ${esc(c.author)} · ${n(c.likes)} likes${c.is_creator ? ' · <b>creator</b>' : ''}</span></li>`)
          .join('');
        return `<div class="group"><div class="gh"><b>${esc(g.label)}</b><span class="rel">${esc(g.reaction_to_creator)}</span><span class="muted">${g.comment_ids.length} comments · ${esc(g.tone)}</span></div><p>${esc(g.point)}</p><ul>${samples}</ul></div>`;
      })
      .join('');
    const commentTotal = (groups?.groups ?? []).reduce((s, g) => s + g.comment_ids.length, 0);
    return `<article data-platform="${esc(p.platform)}" data-news="${card?.newsworthy ? 1 : 0}" data-groups="${groups ? 1 : 0}">
  <header>
    <span class="plat">${esc(P[p.platform])}</span><b>${esc(p.creator)}</b>
    <span class="muted">${esc(p.handle)} · ${esc(when(p.published_at))} · ${esc(p.kind)} · lift ${p.lift} · ${n(p.metrics.likes)} likes · ${n(p.metrics.comments)} comments${p.metrics.views != null ? ` · ${n(p.metrics.views)} views` : ''}</span>
    <a href="${esc(p.url)}" target="_blank" rel="noopener">Open post ↗</a>
  </header>
  <p class="text">${esc(truncate(p.text, 420))}</p>
  ${p.transcript ? `<details><summary>Transcript (${n(p.transcript.length)} characters)</summary><p class="text">${esc(truncate(p.transcript, 1500))}</p></details>` : ''}
  ${
    card
      ? `<section class="card"><h3>Story card <span class="tag">${esc(card.type)}</span><span class="tag ${card.newsworthy ? 'news' : ''}">${card.newsworthy ? 'newsworthy' : 'not newsworthy'}</span><span class="tag">${esc(card.category)}</span></h3>
    <p class="about">${esc(card.about)}</p>
    ${claims ? `<ul class="claims">${claims}</ul>` : ''}
    <p class="muted">Entities: ${(card.entities ?? []).map((e) => `${esc(e.name)} (${e.salience})`).join(', ') || '–'}</p>
    ${(card.events ?? []).length ? `<p class="muted">Events: ${card.events.map((e) => esc(e.what)).join(' · ')}</p>` : ''}</section>`
      : '<p class="muted">No story card</p>'
  }
  ${groups ? `<details class="groups"><summary>${groups.groups.length} comment groups · ${commentTotal} comments grouped · ${groups.dropped.length} dropped as noise</summary>${groupHtml}</details>` : ''}
</article>`;
  })
  .join('\n');

const counts = platforms.map((pl) => `<button type="button" data-filter="${pl}">${esc(P[pl])} <span>${posts.filter((p) => p.platform === pl).length}</span></button>`).join('');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dry run inspector</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
:root{--ground:#EDF0F3;--panel:#FAFBFC;--panel-2:#E2E7EC;--ink:#141B24;--ink-2:#4F5B69;--ink-3:#7C8794;--rule:#CAD2DB;--cold:#2D5BD2;--hot:#D6461A;--mono:"JetBrains Mono",ui-monospace,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--ground:#0E1319;--panel:#151C25;--panel-2:#1F2833;--ink:#E3E8EE;--ink-2:#A1ACB9;--ink-3:#77828F;--rule:#2A3441;--cold:#739DFF;--hot:#FF7B4F}}
*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.5 "Schibsted Grotesk","Segoe UI",system-ui,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:28px}
h1{font-size:30px;margin:0 0 4px;letter-spacing:-.01em}
.lede{color:var(--ink-2);margin:0 0 18px}
.bar{position:sticky;top:0;z-index:2;background:var(--ground);padding:10px 0;display:flex;flex-wrap:wrap;gap:8px;align-items:center;border-bottom:1px solid var(--rule);margin-bottom:16px}
button{font:inherit;font-size:13px;padding:5px 10px;border:1px solid var(--rule);border-radius:4px;background:var(--panel);color:var(--ink);cursor:pointer}
button span{font-family:var(--mono);font-size:11px;color:var(--ink-3)}
button[aria-pressed="true"]{border-color:var(--ink);background:var(--ink);color:var(--ground)}
button[aria-pressed="true"] span{color:var(--ground)}
label{font-size:13px;color:var(--ink-2);display:flex;gap:6px;align-items:center;margin-left:8px}
article{background:var(--panel);border:1px solid var(--rule);border-radius:6px;padding:16px 18px;margin-bottom:12px}
header{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline}
header a{margin-left:auto;font-size:13px;color:var(--cold)}
.plat{font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--hot)}
.muted{color:var(--ink-3);font-size:12.5px}
.text{white-space:pre-wrap;margin:8px 0;color:var(--ink-2);font-size:14px}
.card{border-top:1px dashed var(--rule);margin-top:10px;padding-top:10px}
.card h3{font-size:12px;font-family:var(--mono);font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);margin:0 0 6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.tag{font-size:10.5px;padding:0 6px;border:1px solid var(--rule);border-radius:3px;text-transform:none;letter-spacing:0;color:var(--ink-2)}
.tag.news{border-color:var(--hot);color:var(--hot)}
.about{font-weight:600;margin:0 0 6px}
.claims{margin:0 0 6px;padding-left:18px}
q{display:block;font-style:italic;color:var(--ink-2);font-size:13.5px}
details{margin-top:8px}summary{cursor:pointer;font-size:13px;color:var(--cold)}
.group{border-left:2px solid var(--rule);padding:4px 0 4px 12px;margin:10px 0}
.gh{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline}
.rel{font-family:var(--mono);font-size:11px;padding:0 5px;border:1px solid var(--ink-3);border-radius:3px}
.group p{margin:2px 0;font-size:13.5px;color:var(--ink-2)}
.group ul{margin:4px 0 0;padding-left:18px;font-size:13.5px}
:focus-visible{outline:2px solid var(--cold);outline-offset:2px}
</style></head><body><div class="wrap">
<h1>Dry run inspector</h1>
<p class="lede">${posts.length} posts from the last 7 days with the story card Claude Haiku wrote for each, and the comment groups for the ${groupsByPost.size} posts whose comments were collected. Counts come from code; labels and summaries from Haiku.</p>
<div class="bar"><button type="button" data-filter="all" aria-pressed="true">All <span>${posts.length}</span></button>${counts}
<label><input type="checkbox" id="news"> Newsworthy only</label><label><input type="checkbox" id="withGroups"> With comment groups only</label></div>
${articles}
</div>
<script>
const buttons=[...document.querySelectorAll('[data-filter]')];let platform='all';
const apply=()=>{const news=document.getElementById('news').checked, grp=document.getElementById('withGroups').checked;
document.querySelectorAll('article').forEach(a=>{a.hidden=(platform!=='all'&&a.dataset.platform!==platform)||(news&&a.dataset.news!=='1')||(grp&&a.dataset.groups!=='1');});};
buttons.forEach(b=>b.addEventListener('click',()=>{platform=b.dataset.filter;buttons.forEach(x=>x.setAttribute('aria-pressed',String(x===b)));apply();}));
document.getElementById('news').addEventListener('change',apply);document.getElementById('withGroups').addEventListener('change',apply);
</script></body></html>`;

writeText(join(OUT, 'inspect.html'), html);
console.log(`inspect: ${posts.length} posts → out/inspect.html`);
