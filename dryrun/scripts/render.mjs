// Step 10: turns the JSON on disk into the story feed and story pages.
// Usage: node scripts/render.mjs
import { join } from 'node:path';
import { DATA, OUT, PLATFORM_NAMES as P, loadWorld, readJson, truncate, writeText } from './lib.mjs';

const world = loadWorld();
const { posts, comments, postById, commentById, groupById, claimById, groupsByPost } = world;
const grouping = readJson(join(DATA, 'stories.json'));

// A story leads the feed only if independent sources cover it and people reacted.
const TOP = { minSources: 2, minComments: 10 };
const MIN_COMMENTS_FOR_PCT = 5;
const EVIDENCE_SHOWN = 3;
const NARRATIVE_LEAD = 4;
// Column count that never leaves a card alone on a row: 4 → 2×2, 5 → 3+2.
const cols = (n) => (n <= 3 ? Math.max(1, n) : n === 4 ? 2 : 3);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;
const fmtDay = (iso) => (iso ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(iso)) : '');
const fmtTime = (iso) =>
  iso ? new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : 'time unknown';
const dayRange = (a, b) => (fmtDay(a) === fmtDay(b) ? fmtDay(a) : `${fmtDay(a)} – ${fmtDay(b)}`);
const stripCites = (s) => String(s ?? '').replace(/\s*\[[^\]]*\]\s*$/, '');
const HEAT_HELP = 'Heat combines how far posts beat each creator’s usual engagement, how many independent sources and platforms covered it, how split the reactions are, and how recent it is.';

function describe(id) {
  if (postById.has(id)) {
    const p = postById.get(id);
    return { who: `${P[p.platform]} · ${p.handle} · ${p.kind}`, url: p.url, text: truncate(p.text || p.transcript, 240), creatorId: p.creator_id, platform: p.platform };
  }
  if (commentById.has(id)) {
    const c = commentById.get(id);
    const p = postById.get(c.post_id);
    return { who: `${P[p?.platform] ?? ''} · comment by ${c.author} · ${plural(c.likes, 'like')}`, url: c.url || p?.url, text: truncate(c.text, 240), platform: p?.platform };
  }
  if (groupById.has(id)) {
    const g = groupById.get(id);
    const p = postById.get(g.post_id);
    return { who: `${P[p?.platform] ?? ''} · ${plural((g.comment_ids || []).length, 'comment')} under ${p?.handle}`, url: p?.url, text: g.label, platform: p?.platform };
  }
  if (claimById.has(id)) {
    const k = claimById.get(id);
    const p = postById.get(k.post_id);
    return { who: `${P[p?.platform] ?? ''} · ${p?.handle} · ${p?.kind}`, url: p?.url, text: k.quote ? `“${k.quote}”` : k.text, creatorId: p?.creator_id, platform: p?.platform };
  }
  return { who: `Unknown source ${id}`, url: null, text: '' };
}

function makeCiter() {
  const order = new Map();
  const cite = (ids) =>
    (ids || [])
      .filter(Boolean)
      .map((id) => {
        if (!order.has(id)) order.set(id, order.size + 1);
        return `<a class="cite" href="#src-${order.get(id)}">${order.get(id)}</a>`;
      })
      .join('');
  cite.entries = () => [...order.entries()];
  return cite;
}

function load(id) {
  const file = (dir) => readJson(join(DATA, dir, `${id}.json`), null);
  return {
    narrative: file('narrative'),
    stats: file('stats'),
    written: file('written'),
    check: file('verify'),
    lens: file('lens'),
    lensInput: readJson(join(DATA, 'inputs', 'lens', `${id}.json`), null),
    edit: file('edit'),
  };
}

// Unique comments that were grouped for the story's posts.
function audienceSize(story) {
  const ids = new Set();
  for (const pid of story.post_ids) for (const g of groupsByPost.get(pid)?.groups ?? []) g.comment_ids.forEach((c) => commentById.has(c) && ids.add(c));
  return ids.size;
}

function coverage(stats, audience) {
  const communities = Math.max(0, (stats.sources ?? stats.creators) - stats.creators);
  return [
    stats.creators ? plural(stats.creators, 'creator') : null,
    communities ? plural(communities, 'community', 'communities') : null,
    plural(stats.platforms, 'platform'),
    audience ? plural(audience, 'comment') : 'no comments collected',
  ]
    .filter(Boolean)
    .join(' · ');
}

const whyNotTop = (stats, audience) =>
  (stats.sources ?? stats.creators) < TOP.minSources ? 'one source' : audience === 0 ? 'no comments collected' : audience < TOP.minComments ? 'few comments' : '';

const stripHtml = (edit) =>
  (edit?.platform_strip || []).length
    ? `<ul class="strip">${edit.platform_strip.map((s) => `<li><b>${esc(P[s.platform] ?? s.platform)}</b><span>${esc(s.gist)}</span></li>`).join('')}</ul>`
    : '';

const CSS = `
:root{--ground:#EDF0F3;--panel:#FAFBFC;--panel-2:#E2E7EC;--ink:#141B24;--ink-2:#4F5B69;--ink-3:#7C8794;--rule:#CAD2DB;--cold:#2D5BD2;--hot:#D6461A;
--display:"Schibsted Grotesk","Segoe UI",system-ui,sans-serif;--serif:"Newsreader",Georgia,"Times New Roman",serif;--mono:"JetBrains Mono",ui-monospace,Consolas,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--ground:#0E1319;--panel:#151C25;--panel-2:#1F2833;--ink:#E3E8EE;--ink-2:#A1ACB9;--ink-3:#77828F;--rule:#2A3441;--cold:#739DFF;--hot:#FF7B4F}}
:root[data-theme="dark"]{--ground:#0E1319;--panel:#151C25;--panel-2:#1F2833;--ink:#E3E8EE;--ink-2:#A1ACB9;--ink-3:#77828F;--rule:#2A3441;--cold:#739DFF;--hot:#FF7B4F}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--display);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:inherit}
:focus-visible{outline:2px solid var(--cold);outline-offset:2px}
.wrap{max-width:1120px;margin:0 auto;padding:24px 28px 56px}
.bar{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px 16px;font-family:var(--mono);font-size:11.5px;color:var(--ink-3);margin-bottom:16px}
.bar a{text-decoration:none}.bar a:hover{color:var(--ink)}
.flag{letter-spacing:.06em;text-transform:uppercase}
.eyebrow{margin:0;font-family:var(--mono);font-size:11.5px;color:var(--ink-3)}
.eyebrow .mc{color:var(--hot);font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.dek{font-family:var(--serif);font-size:18px;line-height:1.45;color:var(--ink-2);margin:8px 0 0;max-width:68ch;text-wrap:pretty}
.cov{margin:10px 0 0;font-family:var(--mono);font-size:12px;color:var(--ink-2)}
.warn{color:var(--hot)}
.heat{color:var(--hot);font-weight:600}
ul.strip{list-style:none;margin:14px 0 0;padding:12px 0 0;border-top:1px dashed var(--rule);display:grid;gap:5px;max-width:780px}
ul.strip li{display:grid;grid-template-columns:86px minmax(0,1fr);gap:10px;font-size:14.5px;align-items:baseline}
ul.strip b{font-family:var(--mono);font-size:10.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3)}

.page{background:var(--panel);border:1px solid var(--rule);border-radius:8px;overflow:hidden}
.hero{padding:28px 30px 24px;border-bottom:1px solid var(--rule)}
.hero h1{font-size:36px;line-height:1.1;letter-spacing:-.02em;margin:8px 0 0;max-width:32ch;text-wrap:balance}
.body{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr)}
.main{padding:24px 30px;border-right:1px solid var(--rule)}
.side{padding:24px 26px}
h2{font-family:var(--mono);font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);margin:28px 0 10px;font-weight:500}
.main > h2:first-child,.side > h2:first-child,.lens > h2,.band > h2,.angles > h2{margin-top:0}
.character{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 12px;margin:0 0 14px;padding-bottom:12px;border-bottom:1px solid var(--rule)}
.character .role{font-family:var(--mono);font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--hot)}
.character b{font-size:19px;font-weight:800}
.character .cast{flex-basis:100%;font-size:13px;color:var(--ink-2)}
.narrative{font-family:var(--serif);font-size:17.5px;line-height:1.62;margin:0;max-width:66ch}
.cite{font-family:var(--mono);font-size:9.5px;color:var(--ink-3);vertical-align:super;margin-left:1px;text-decoration:none}
.cite:hover{color:var(--cold);text-decoration:underline}
.beats{list-style:none;margin:0;padding:0}
.beats li{display:grid;grid-template-columns:96px 16px minmax(0,1fr);column-gap:10px;padding-bottom:14px;font-size:14.5px}
.beats li:last-child{padding-bottom:0}
.beats time{font-family:var(--mono);font-size:11px;color:var(--ink-3);padding-top:3px}
.node{position:relative}
.node::before{content:"";position:absolute;left:7px;top:6px;bottom:-20px;width:2px;background:var(--rule)}
.beats li:last-child .node::before{display:none}
.node::after{content:"";position:absolute;left:2px;top:6px;width:12px;height:12px;border-radius:50%;background:var(--panel);border:2px solid var(--ink-3)}
.turn .node::after{background:var(--hot);border-color:var(--hot)}
.src{display:block;font-family:var(--mono);font-size:11px;color:var(--ink-3);margin-top:2px}
.tag{font-family:var(--mono);font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--hot);margin-left:8px;white-space:nowrap}
.open{margin:0;padding-left:18px;font-size:14.5px}
.note{font-family:var(--serif);font-size:14.5px;color:var(--ink-2);margin:0 0 10px}
.a0{--a:var(--hot)}.a1{--a:var(--cold)}.a2{--a:var(--ink-3)}.a3{--a:color-mix(in oklab,var(--hot) 50%,var(--cold))}.a4{--a:var(--ink-2)}
.dot{display:inline-block;width:9px;height:9px;border-radius:2px;background:var(--a);flex:none}
.track{display:block;height:5px;background:var(--panel-2);border-radius:2px;overflow:hidden}
.track i{display:block;height:100%;background:var(--a)}
.stands .stand{padding:11px 0;display:grid;gap:6px}
.stands .stand + .stand{border-top:1px solid var(--rule)}
.st-h{display:grid;grid-template-columns:9px minmax(0,1fr) auto;gap:9px;align-items:baseline}
.st-h b{font-size:14px;font-weight:600;line-height:1.3}
.st-h .pct{font-family:var(--mono);font-size:13px;font-variant-numeric:tabular-nums;white-space:nowrap}
.st-h .pct small{color:var(--ink-3);font-size:11px}
.st-p{display:flex;flex-wrap:wrap;gap:3px 12px;font-family:var(--mono);font-size:11px;color:var(--ink-2);padding-left:18px}
.st-p small{color:var(--ink-3)}
.muted{color:var(--ink-3)}

.lens,.band,.angles{padding:24px 30px;border-top:1px solid var(--rule)}
.contrast{font-family:var(--serif);font-size:17px;line-height:1.55;margin:0 0 16px;max-width:78ch}
.lgrid,.agrid{display:grid;grid-template-columns:repeat(var(--cols,2),minmax(0,1fr));gap:14px}
details.more .narrative{margin-top:10px}
.pcard{border:1px solid var(--rule);border-radius:6px;padding:14px 16px;display:flex;flex-direction:column;gap:8px;background:var(--ground)}
.pcard header{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.pcard header b{font-size:17px}
.pcard p{margin:0;font-size:14px;line-height:1.45}
.pcard .take{font-weight:650;font-size:15.5px;line-height:1.35}
.lbl{display:inline-block;font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);margin-right:6px}
.pcard blockquote{margin:0;font-family:var(--serif);font-size:15px;border-left:2px solid var(--rule);padding-left:10px}
.minis{display:grid;gap:6px}
.mini{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;font-size:12.5px}
.mini .pct{font-family:var(--mono);font-size:12px}
.mini .pct small{color:var(--ink-3)}
.mini .track{grid-column:1 / -1}
.pcard .distinct{font-size:13px;color:var(--ink-3);border-top:1px dashed var(--rule);padding-top:8px}

.acard{border:1px solid var(--rule);border-radius:6px;padding:14px 16px;display:flex;flex-direction:column;gap:6px;background:var(--ground)}
.kind{display:flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}
.acard b{font-size:16px;line-height:1.25}
.thesis{font-family:var(--serif);font-size:15px;color:var(--ink-2);margin:0}
.strength{font-family:var(--mono);font-size:11px;color:var(--ink-2)}
.ev{list-style:none;margin:4px 0 0;padding:10px 0 0;border-top:1px dashed var(--rule);display:grid;gap:10px}
.ev li{font-size:13.5px;line-height:1.4}
.who{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-family:var(--mono);font-size:11px;color:var(--ink-3);margin-bottom:1px}
.rel{font-size:10px;padding:0 5px;border:1px solid var(--ink-3);border-radius:3px;color:var(--ink-2);white-space:nowrap}
.rel.contradicts{border-style:dashed}
details.more summary{cursor:pointer;font-family:var(--mono);font-size:11.5px;color:var(--cold);margin-top:8px}

.foot{padding:14px 30px 20px;border-top:1px solid var(--rule);display:grid;gap:8px}
.foot summary{cursor:pointer;font-family:var(--mono);font-size:12px;color:var(--ink-2)}
.foot ol,.foot ul{margin:10px 0 4px;padding-left:22px;display:grid;gap:6px;font-size:13px}
.snip{display:block;color:var(--ink-3);font-size:12px}

.ihead{margin:4px 0 8px}
.ihead h1{font-size:42px;letter-spacing:-.025em;margin:6px 0 0;line-height:1.02}
.totals{display:flex;flex-wrap:wrap;gap:6px 18px;font-family:var(--mono);font-size:12px;color:var(--ink-2);margin-top:12px}
.totals b{color:var(--ink);font-weight:600}
.sect{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;margin:32px 0 12px;font-weight:700;color:var(--ink)}
.sect span{font-family:var(--mono);font-size:11.5px;letter-spacing:0;text-transform:none;color:var(--ink-3);font-weight:400}
.feed{display:grid;gap:12px}
a.story{display:grid;grid-template-columns:minmax(0,1fr) 60px;gap:20px;text-decoration:none;background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:18px 22px}
a.story:hover{border-color:var(--ink-3)}
a.story h3{font-size:22px;line-height:1.2;letter-spacing:-.012em;margin:6px 0 0;text-wrap:balance}
a.story .dek{font-size:16px;margin-top:6px}
a.story ul.strip li{font-size:13.5px}
.heatbox{text-align:right;font-variant-numeric:tabular-nums;padding-top:2px}
.heatbox b{display:block;font-size:26px;font-weight:800;color:var(--hot);line-height:1}
.heatbox span{font-family:var(--mono);font-size:9.5px;color:var(--ink-3);letter-spacing:.08em;text-transform:uppercase}
.feed.compact a.story{padding:13px 20px}
.feed.compact h3{font-size:17px}
.feed.compact .heatbox b{font-size:19px}
.why{display:inline-block;margin-left:6px;font-family:var(--mono);font-size:10.5px;padding:0 6px;border:1px dashed var(--ink-3);border-radius:3px;color:var(--ink-2)}
.pagefoot{margin-top:28px;font-family:var(--mono);font-size:12px;color:var(--ink-3);display:grid;gap:8px}
.pagefoot a{color:var(--cold)}
@media (max-width:860px){.lgrid,.agrid{grid-template-columns:1fr}.body{grid-template-columns:1fr}.main{border-right:0;border-bottom:1px solid var(--rule)}.hero h1{font-size:28px}.ihead h1{font-size:32px}a.story{grid-template-columns:1fr}.heatbox{text-align:left}}
`;

const FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;600;700;800&family=Newsreader:opsz,wght@6..72,400;6..72,500&family=JetBrains+Mono:wght@400;500;600&display=swap">';
const OPEN_SOURCES = '<script>document.addEventListener("click",function(e){var a=e.target.closest("a.cite");if(!a)return;var d=document.getElementById("sources");if(d&&!d.open)d.open=true;});</script>';
const shell = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${FONTS}<style>${CSS}</style></head><body><div class="wrap">${body}</div>${OPEN_SOURCES}</body></html>`;

function storyPage(story) {
  const { narrative, stats, written, check, lens, lensInput, edit } = load(story.story_id);
  if (!narrative || !stats || !written) return null;
  const cite = makeCiter();
  const audience = audienceSize(story);
  const headline = edit?.headline || written.headline;
  const angles = narrative.angles || [];
  const turning = new Set(stats.turning_points);

  // The story, in our words
  const cast = (narrative.supporting_cast || []).slice(0, 4).map((c) => `<span title="${esc(c.role)}">${esc(c.name)}</span>`).join(' · ');
  const sentenceHtml = (written.narrative || []).map((s) => `${esc(stripCites(s.sentence))}${cite(s.cites)}`);
  const lead = sentenceHtml.slice(0, NARRATIVE_LEAD).join(' ');
  const more = sentenceHtml.slice(NARRATIVE_LEAD).join(' ');

  // What each platform is saying
  const lensCards = (lens?.platforms || [])
    .map((pl) => {
      const nums = lensInput?.platforms.find((b) => b.platform === pl.platform)?.numbers;
      const creators = lensInput?.platforms.find((b) => b.platform === pl.platform)?.creators || [];
      const quoteKey = `lens:${pl.platform}`;
      const quoteSource = check?.quote_sources?.[quoteKey] ?? pl.quote?.source_id;
      const bars = (nums?.angle_agreement || [])
        .filter((a) => a.agree_pct != null && a.comments >= MIN_COMMENTS_FOR_PCT)
        .map((a) => `<div class="mini a${a.angle_index % 5}"><span>${esc(angles[a.angle_index]?.title)}</span><span class="pct">${a.agree_pct}% <small>of ${fmtNum(a.comments)}</small></span><span class="track"><i style="width:${a.agree_pct}%"></i></span></div>`)
        .join('');
      return `<article class="pcard">
        <header><b>${esc(P[pl.platform] ?? pl.platform)}</b><span class="muted">${plural(nums?.posts ?? 0, 'post')} · ${plural(nums?.comments_grouped ?? 0, 'comment')}</span></header>
        <span class="src">${esc(creators.join(' · '))}</span>
        <p class="take">${esc(pl.take)}</p>
        ${pl.creators_say?.text ? `<p><span class="lbl">Creators</span>${esc(stripCites(pl.creators_say.text))}${cite(pl.creators_say.cites)}</p>` : ''}
        ${pl.audience_says?.text ? `<p><span class="lbl">Audience</span>${esc(stripCites(pl.audience_says.text))}${cite(pl.audience_says.cites)}</p>` : '<p class="muted">No comments collected here.</p>'}
        ${pl.quote?.text && !check?.hidden_quotes?.includes(quoteKey) ? `<blockquote>“${esc(pl.quote.text)}”${cite([quoteSource])}</blockquote>` : ''}
        ${bars ? `<div class="minis">${bars}</div>` : ''}
        ${pl.distinct ? `<p class="distinct">${esc(pl.distinct)}</p>` : ''}
      </article>`;
    })
    .join('');
  const lensHtml = lens
    ? `<section class="lens"><h2>What each platform is saying</h2>${(lens.contrast || []).length ? `<p class="contrast">${lens.contrast.map((s) => `${esc(stripCites(s.sentence))}${cite(s.cites)}`).join(' ')}</p>` : ''}<div class="lgrid" style="--cols:${cols((lens?.platforms || []).length)}">${lensCards}</div></section>`
    : '';

  // How it unfolded
  const beats = stats.beat_order
    .map((i) => {
      const beat = narrative.beats[i];
      const sources = [...(beat.source_post_ids || []), ...(beat.source_comment_ids || [])];
      const first = describe(sources[0]);
      const more = sources.length > 1 ? ` · +${sources.length - 1} more` : '';
      return `<li class="${turning.has(i) ? 'turn' : ''}"><time>${esc(fmtTime(stats.beat_times[i]?.at))}</time><span class="node"></span><span>${esc(written.beat_lines?.[i] || beat.what)}${turning.has(i) ? '<span class="tag">turning point</span>' : ''}${cite(sources)}<span class="src">${esc(first.who)}${more}</span></span></li>`;
    })
    .join('');
  const open = (narrative.open_questions || []).map((q) => `<li>${esc(q.question)}${cite(q.asked_in)}</li>`).join('');

  // Where audiences stand
  const stands = angles
    .map((a, i) => {
      const r = stats.angle_reactions[i];
      const total = r?.total;
      const enough = total && total.agree_pct != null && total.comments >= MIN_COMMENTS_FOR_PCT;
      const value =
        a.kind === 'question' || (total && total.agree_pct == null && total.asks)
          ? `${plural(total?.asks ?? 0, 'ask')}`
          : enough
            ? `${total.agree_pct}% <small>of ${fmtNum(total.comments)}</small>`
            : '<small>too few comments</small>';
      const perPlatform = (r?.by_platform || [])
        .filter((p) => p.agree_pct != null && p.comments >= MIN_COMMENTS_FOR_PCT)
        .map((p) => `<span>${esc(P[p.platform])} ${p.agree_pct}%<small> · ${fmtNum(p.comments)}</small></span>`)
        .join('');
      return `<div class="stand a${i % 5}"><div class="st-h"><span class="dot"></span><b>${esc(a.title)}</b><span class="pct">${value}</span></div>${enough ? `<span class="track"><i style="width:${total.agree_pct}%"></i></span>` : ''}${perPlatform ? `<div class="st-p">${perPlatform}</div>` : ''}</div>`;
    })
    .join('');
  const shifts = stats.reaction_shifts
    .map((s) => `<p class="note">After “${esc(written.beat_lines?.[s.after_beat] || narrative.beats[s.after_beat]?.what)}”, agreement with <b>${esc(angles[s.angle_index]?.title)}</b> on ${esc(P[s.platform])} moved from ${s.before_pct}% to ${s.after_pct}%.</p>`)
    .join('');

  // The arguments, with evidence
  const angleCards = angles
    .map((a, i) => {
      const blurb = (written.angle_blurbs || []).find((b) => b.angle_index === i);
      const ev = (a.evidence || []).map((e) => ({ ...e, d: describe(e.source_id) }));
      const creators = new Set(ev.map((e) => e.d.creatorId).filter(Boolean)).size;
      const plats = new Set(ev.map((e) => e.d.platform).filter(Boolean)).size;
      const item = (e) => `<li><span class="who"><span>${esc(e.d.who)}</span><span class="rel ${esc(e.relation)}">${esc(e.relation)}</span></span>${esc(e.d.text)}${cite([e.source_id])}</li>`;
      const shown = ev.slice(0, EVIDENCE_SHOWN).map(item).join('');
      const rest = ev.slice(EVIDENCE_SHOWN);
      return `<article class="acard a${i % 5}"><span class="kind"><span class="dot"></span>${esc(a.kind)}</span><b>${esc(a.title)}</b><p class="thesis">${esc(blurb ? stripCites(blurb.text) : a.thesis)}${blurb ? cite(blurb.cites) : ''}</p><span class="strength">${[creators ? plural(creators, 'creator') : null, plural(plats, 'platform'), plural(ev.length, 'piece of evidence', 'pieces of evidence')].filter(Boolean).join(' · ')}</span><ul class="ev">${shown}</ul>${rest.length ? `<details class="more"><summary>Show ${rest.length} more</summary><ul class="ev">${rest.map(item).join('')}</ul></details>` : ''}</article>`;
    })
    .join('');

  const sourceList = cite
    .entries()
    .map(([sid, n]) => {
      const d = describe(sid);
      return `<li id="src-${n}">${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.who)}</a>` : esc(d.who)}<span class="snip">${esc(d.text)}</span></li>`;
    })
    .join('');
  const checkNotes = check ? [...check.errors.map((e) => `Error: ${e}`), ...check.warnings] : [];
  const checkSummary = check ? `${check.pass ? 'Passed' : 'Needs review'}: every citation, quote and number checked against the collected posts and comments` : 'Not checked yet';

  const body = `
  <div class="bar"><a href="index.html">← This week’s stories</a><span class="flag">Dry run · words by Claude · numbers by code</span></div>
  <article class="page">
    <header class="hero">
      <p class="eyebrow"><span class="mc">${esc(narrative.main_character?.name)}</span> · ${esc(stats.category)} · ${esc(dayRange(stats.first_post_at, stats.last_post_at))}</p>
      <h1>${esc(headline)}</h1>
      ${edit?.dek ? `<p class="dek">${esc(edit.dek)}</p>` : ''}
      <p class="cov">${esc(coverage(stats, audience))} · <span class="heat" title="${esc(HEAT_HELP)}">heat ${stats.heat}</span></p>
      ${stripHtml(edit)}
    </header>
    <div class="body">
      <div class="main">
        <h2>The story</h2>
        <div class="character"><span class="role">Main character</span><b>${esc(narrative.main_character?.name)}</b>${cast ? `<span class="cast">With ${cast}</span>` : ''}</div>
        <p class="narrative">${lead}</p>
        ${more ? `<details class="more"><summary>Continue reading</summary><p class="narrative">${more}</p></details>` : ''}
        <h2>How it unfolded</h2>
        <ol class="beats">${beats}</ol>
        ${open ? `<h2>Still unanswered</h2><ul class="open">${open}</ul>` : ''}
      </div>
      <aside class="side">
        <h2>Where audiences stand</h2>
        ${audience ? `<p class="note">Share of the comments on each argument that agree with it, weighted by likes. Percentages appear only where at least ${MIN_COMMENTS_FOR_PCT} comments address it.</p><div class="stands">${stands}</div>` : '<p class="note">No comments were collected for this story’s posts, so there’s no audience reaction to show.</p>'}
        ${shifts ? `<h2>Where reaction shifted</h2>${shifts}` : ''}
      </aside>
    </div>
    ${lensHtml}
    <section class="angles"><h2>The arguments, with evidence</h2><div class="agrid" style="--cols:${cols(angles.length)}">${angleCards}</div></section>
    <footer class="foot">
      <details id="sources"><summary>Sources (${cite.entries().length})</summary><ol>${sourceList}</ol></details>
      <details><summary>${esc(checkSummary)}${checkNotes.length ? ` · ${plural(checkNotes.length, 'note')}` : ''}</summary>${checkNotes.length ? `<ul>${checkNotes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</details>
    </footer>
  </article>`;
  return { html: shell(headline, body), stats, written, narrative, check, edit, audience, headline };
}

const rendered = [];
for (const story of grouping.stories) {
  const page = storyPage(story);
  if (!page) {
    console.log(`${story.story_id}: missing narrative, stats or written story, skipped`);
    continue;
  }
  writeText(join(OUT, `${story.story_id}.html`), page.html);
  rendered.push({ story, ...page });
}

rendered.sort((a, b) => b.stats.heat - a.stats.heat);
const isTop = (r) => !whyNotTop(r.stats, r.audience);
const card = (r, compact) => {
  const why = whyNotTop(r.stats, r.audience);
  return `<a class="story" href="${esc(r.story.story_id)}.html">
    <div>
      <p class="eyebrow"><span class="mc">${esc(r.narrative.main_character?.name)}</span> · ${esc(r.stats.category)} · ${esc(dayRange(r.stats.first_post_at, r.stats.last_post_at))}${compact && why ? `<span class="why">${esc(why)}</span>` : ''}</p>
      <h3>${esc(r.headline)}</h3>
      ${!compact && r.edit?.dek ? `<p class="dek">${esc(r.edit.dek)}</p>` : ''}
      ${compact ? '' : stripHtml(r.edit)}
      <p class="cov">${esc(coverage(r.stats, r.audience))}${r.check && !r.check.pass ? ' · <span class="warn">needs review</span>' : ''}</p>
    </div>
    <div class="heatbox" title="${esc(HEAT_HELP)}"><b>${r.stats.heat}</b><span>heat</span></div>
  </a>`;
};
const top = rendered.filter(isTop);
const rest = rendered.filter((r) => !isTop(r));
const allTimes = posts.map((p) => p.published_at).filter(Boolean).sort();
const uncertain = (grouping.uncertain || []).map((u) => `<li>${esc(u.post_id)} → ${esc(u.placed_in)} (or ${esc(u.alternative)}): ${esc(u.reason)}</li>`).join('');
const merges = (grouping.merges || []).map((m) => `<li>${esc(m.from)} merged into ${esc(m.into)}: ${esc(m.reason)}</li>`).join('');

const index = `
  <div class="bar"><span class="flag">Content-Story · dry run</span><span>${esc(dayRange(allTimes[0], allTimes.at(-1)))}</span></div>
  <header class="ihead">
    <p class="eyebrow">AI &amp; tech · 10 creators · 3 communities · X, YouTube, LinkedIn, Instagram, TikTok, Reddit</p>
    <h1>This week’s stories</h1>
    <p class="totals"><span><b>${fmtNum(posts.length)}</b> posts</span><span><b>${fmtNum(comments.length)}</b> comments</span><span><b>${rendered.length}</b> stories</span><span><b>${fmtNum((grouping.unassigned || []).length)}</b> newsworthy posts in no story</span></p>
  </header>
  <h2 class="sect">Top stories <span>covered by ${TOP.minSources}+ independent sources, with audience reaction</span></h2>
  <div class="feed">${top.map((r) => card(r, false)).join('') || '<p class="note">No story meets the bar yet.</p>'}</div>
  ${rest.length ? `<h2 class="sect">Also this week <span>one source, or little audience reaction so far</span></h2><div class="feed compact">${rest.map((r) => card(r, true)).join('')}</div>` : ''}
  <footer class="pagefoot">
    <a href="inspect.html">Inspect every post, story card and comment group →</a>
    ${merges || uncertain ? `<details><summary>Editorial decisions behind the grouping</summary><ul>${merges}${uncertain}</ul></details>` : ''}
  </footer>`;
writeText(join(OUT, 'index.html'), shell('This week’s stories', index));
console.log(`render: ${rendered.length} story pages (${top.length} top, ${rest.length} also) + index → out/`);
