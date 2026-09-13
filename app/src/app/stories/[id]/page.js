import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { HEAT_HELP, PLATFORM_NAMES as P, dayRange, fmtNum, fmtTime, plural, stripCites } from '../../../../lib/format.js';
import { MIN_COMMENTS_FOR_PCT, getStory } from '../../../../lib/stories.js';
import OpenSourcesOnCite from '../../components/open-sources.js';

export const dynamic = 'force-dynamic';

const EVIDENCE_SHOWN = 3;
const NARRATIVE_LEAD = 4;
// Column count that never leaves a card alone on a row: 4 → 2×2, 5 → 3+2.
const cols = (n) => (n <= 3 ? Math.max(1, n) : n === 4 ? 2 : 3);

const loadStory = cache(getStory);

export async function generateMetadata({ params }) {
  const { id } = await params;
  const story = await loadStory(id);
  return { title: story ? story.feed_edit?.headline ?? story.written.headline : 'Story not found' };
}

// Numbers citations in the order they're first used and remembers them for the sources list.
function makeCiter() {
  const order = new Map();
  const cite = (ids, keyPrefix) =>
    (ids ?? []).filter(Boolean).map((id) => {
      if (!order.has(id)) order.set(id, order.size + 1);
      const n = order.get(id);
      return (
        <a key={`${keyPrefix}-${id}`} className="cite" href={`#src-${n}`}>
          {n}
        </a>
      );
    });
  cite.entries = () => [...order.entries()];
  return cite;
}

export default async function StoryPage({ params }) {
  const { id } = await params;
  const story = await loadStory(id);
  if (!story) notFound();

  const { narrative, stats, written, platform_takes: lens, feed_edit: edit, checks, sources, platforms } = story;
  const angles = narrative.angles ?? [];
  const turning = new Set(stats.turning_points ?? []);
  const cite = makeCiter();
  const describe = (sourceId) => sources[sourceId] ?? { who: `Unknown source ${sourceId}`, url: null, text: '' };
  const headline = edit?.headline ?? written.headline;

  // The story, in our words
  const sentences = (written.narrative ?? []).map((s, i) => (
    <span key={`n${i}`}>
      {i ? ' ' : ''}
      {stripCites(s.sentence)}
      {cite(s.cites, `n${i}`)}
    </span>
  ));

  // What each platform is saying
  const contrast = (lens?.contrast ?? []).map((s, i) => (
    <span key={`c${i}`}>
      {i ? ' ' : ''}
      {stripCites(s.sentence)}
      {cite(s.cites, `c${i}`)}
    </span>
  ));
  const lensCards = (lens?.platforms ?? []).map((pl) => {
    const nums = platforms[pl.platform] ?? { posts: 0, commentsGrouped: 0, creators: [], angleAgreement: [] };
    const creatorsCite = pl.creators_say?.text ? cite(pl.creators_say.cites, `cs-${pl.platform}`) : null;
    const audienceCite = pl.audience_says?.text ? cite(pl.audience_says.cites, `as-${pl.platform}`) : null;
    const quoteKey = `lens:${pl.platform}`;
    const showQuote = Boolean(pl.quote?.text) && !(checks?.hidden_quotes ?? []).includes(quoteKey);
    const quoteCite = showQuote ? cite([checks?.quote_sources?.[quoteKey] ?? pl.quote.source_id], `q-${pl.platform}`) : null;
    const bars = nums.angleAgreement.filter((a) => a.agreePct != null && a.comments >= MIN_COMMENTS_FOR_PCT);
    return (
      <article className="pcard" key={pl.platform}>
        <header>
          <b>{P[pl.platform] ?? pl.platform}</b>
          <span className="muted">
            {plural(nums.posts, 'post')} · {plural(nums.commentsGrouped, 'comment')}
          </span>
        </header>
        <span className="src">{nums.creators.join(' · ')}</span>
        <p className="take">{pl.take}</p>
        {pl.creators_say?.text ? (
          <p>
            <span className="lbl">Creators</span>
            {stripCites(pl.creators_say.text)}
            {creatorsCite}
          </p>
        ) : null}
        {pl.audience_says?.text ? (
          <p>
            <span className="lbl">Audience</span>
            {stripCites(pl.audience_says.text)}
            {audienceCite}
          </p>
        ) : (
          <p className="muted">No comments collected here.</p>
        )}
        {showQuote ? (
          <blockquote>
            “{pl.quote.text}”{quoteCite}
          </blockquote>
        ) : null}
        {bars.length ? (
          <div className="minis">
            {bars.map((a) => (
              <div key={a.angleIndex} className={`mini a${a.angleIndex % 5}`}>
                <span>{angles[a.angleIndex]?.title}</span>
                <span className="pct">
                  {a.agreePct}% <small>of {fmtNum(a.comments)}</small>
                </span>
                <span className="track">
                  <i style={{ width: `${a.agreePct}%` }} />
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {pl.distinct ? <p className="distinct">{pl.distinct}</p> : null}
      </article>
    );
  });

  // How it unfolded
  const beats = (stats.beat_order ?? []).map((i) => {
    const beat = narrative.beats[i];
    const ids = [...(beat.source_post_ids ?? []), ...(beat.source_comment_ids ?? [])];
    return (
      <li key={i} className={turning.has(i) ? 'turn' : undefined}>
        <time>{fmtTime(stats.beat_times?.[i]?.at)}</time>
        <span className="node" />
        <span>
          {written.beat_lines?.[i] ?? beat.what}
          {turning.has(i) ? <span className="tag">turning point</span> : null}
          {cite(ids, `b${i}`)}
          <span className="src">
            {describe(ids[0]).who}
            {ids.length > 1 ? ` · +${ids.length - 1} more` : ''}
          </span>
        </span>
      </li>
    );
  });
  const openQuestions = (narrative.open_questions ?? []).map((q, i) => (
    <li key={i}>
      {q.question}
      {cite(q.asked_in, `o${i}`)}
    </li>
  ));

  // Where audiences stand
  const stands = angles.map((a, i) => {
    const reaction = stats.angle_reactions?.[i];
    const total = reaction?.total;
    const isAsks = a.kind === 'question' || (total && total.agree_pct == null && total.asks);
    const enough = total && total.agree_pct != null && total.comments >= MIN_COMMENTS_FOR_PCT;
    const perPlatform = (reaction?.by_platform ?? []).filter((p) => p.agree_pct != null && p.comments >= MIN_COMMENTS_FOR_PCT);
    return (
      <div key={i} className={`stand a${i % 5}`}>
        <div className="st-h">
          <span className="dot" />
          <b>{a.title}</b>
          <span className="pct">
            {isAsks ? (
              plural(total?.asks ?? 0, 'ask')
            ) : enough ? (
              <>
                {total.agree_pct}% <small>of {fmtNum(total.comments)}</small>
              </>
            ) : (
              <small>too few comments</small>
            )}
          </span>
        </div>
        {enough && !isAsks ? (
          <span className="track">
            <i style={{ width: `${total.agree_pct}%` }} />
          </span>
        ) : null}
        {perPlatform.length ? (
          <div className="st-p">
            {perPlatform.map((p) => (
              <span key={p.platform}>
                {P[p.platform]} {p.agree_pct}%<small> · {fmtNum(p.comments)}</small>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    );
  });

  // The arguments, with evidence
  const angleCards = angles.map((a, i) => {
    const blurb = (written.angle_blurbs ?? []).find((b) => b.angle_index === i);
    const blurbCite = blurb ? cite(blurb.cites, `ab${i}`) : null;
    const evidence = (a.evidence ?? []).map((e, j) => ({ ...e, j, d: describe(e.source_id) }));
    const creators = new Set(evidence.map((e) => e.d.creatorId).filter(Boolean)).size;
    const platformCount = new Set(evidence.map((e) => e.d.platform).filter(Boolean)).size;
    const item = (e) => (
      <li key={e.j}>
        <span className="who">
          <span>{e.d.who}</span>
          <span className={`rel ${e.relation}`}>{e.relation}</span>
        </span>
        {e.d.text}
        {cite([e.source_id], `ev${i}-${e.j}`)}
      </li>
    );
    const shown = evidence.slice(0, EVIDENCE_SHOWN).map(item);
    const rest = evidence.slice(EVIDENCE_SHOWN).map(item);
    return (
      <article key={i} className={`acard a${i % 5}`}>
        <span className="kind">
          <span className="dot" />
          {a.kind}
        </span>
        <b>{a.title}</b>
        <p className="thesis">
          {blurb ? stripCites(blurb.text) : a.thesis}
          {blurbCite}
        </p>
        <span className="strength">
          {[creators ? plural(creators, 'creator') : null, plural(platformCount, 'platform'), plural(evidence.length, 'piece of evidence', 'pieces of evidence')]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <ul className="ev">{shown}</ul>
        {rest.length ? (
          <details className="more">
            <summary>Show {rest.length} more</summary>
            <ul className="ev">{rest}</ul>
          </details>
        ) : null}
      </article>
    );
  });

  const communities = Math.max(0, (stats.sources ?? stats.creators) - stats.creators);
  const coverage = [
    stats.creators ? plural(stats.creators, 'creator') : null,
    communities ? plural(communities, 'community', 'communities') : null,
    plural(stats.platforms, 'platform'),
    story.audience ? plural(story.audience, 'comment') : 'no comments collected',
  ]
    .filter(Boolean)
    .join(' · ');
  const cast = (narrative.supporting_cast ?? [])
    .slice(0, 4)
    .map((c) => c.name)
    .join(' · ');
  const checkNotes = [...(checks?.errors ?? []).map((e) => `Error: ${e}`), ...(checks?.warnings ?? [])];

  // Built last, after every citation above has been numbered.
  const sourceItems = cite.entries().map(([sourceId, n]) => {
    const d = describe(sourceId);
    return (
      <li key={sourceId} id={`src-${n}`}>
        {d.url ? (
          <a href={d.url} target="_blank" rel="noopener noreferrer">
            {d.who}
          </a>
        ) : (
          d.who
        )}
        <span className="snip">{d.text}</span>
      </li>
    );
  });

  return (
    <main>
      <p className="eyebrow" style={{ marginBottom: 12 }}>
        <Link href="/">← This week’s stories</Link>
      </p>
      <article className="page">
        <header className="hero">
          <p className="eyebrow">
            <span className="mc">{narrative.main_character?.name}</span> · {story.category} · {dayRange(story.first_post_at, story.last_post_at)}
          </p>
          <h1>{headline}</h1>
          {edit?.dek ? <p className="dek">{edit.dek}</p> : null}
          <p className="cov">
            {coverage} ·{' '}
            <span className="heat" title={HEAT_HELP}>
              heat {story.heat}
            </span>
          </p>
          {edit?.platform_strip?.length ? (
            <ul className="strip">
              {edit.platform_strip.map((s) => (
                <li key={s.platform}>
                  <b>{P[s.platform] ?? s.platform}</b>
                  <span>{s.gist}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </header>

        <div className="body">
          <div className="main">
            <h2 className="label">The story</h2>
            <div className="character">
              <span className="role">Main character</span>
              <b>{narrative.main_character?.name}</b>
              {cast ? <span className="cast">With {cast}</span> : null}
            </div>
            <p className="narrative">{sentences.slice(0, NARRATIVE_LEAD)}</p>
            {sentences.length > NARRATIVE_LEAD ? (
              <details className="more">
                <summary>Continue reading</summary>
                <p className="narrative">{sentences.slice(NARRATIVE_LEAD)}</p>
              </details>
            ) : null}
            <h2 className="label">How it unfolded</h2>
            <ol className="beats">{beats}</ol>
            {openQuestions.length ? (
              <>
                <h2 className="label">Still unanswered</h2>
                <ul className="open">{openQuestions}</ul>
              </>
            ) : null}
          </div>
          <aside className="side">
            <h2 className="label">Where audiences stand</h2>
            {story.audience ? (
              <>
                <p className="note">
                  Share of the comments on each argument that agree with it, weighted by likes. Percentages appear only where at least {MIN_COMMENTS_FOR_PCT} comments
                  address it.
                </p>
                <div className="stands">{stands}</div>
              </>
            ) : (
              <p className="note">No comments were collected for this story’s posts, so there’s no audience reaction to show.</p>
            )}
          </aside>
        </div>

        {lensCards.length ? (
          <section className="band">
            <h2 className="label">What each platform is saying</h2>
            {contrast.length ? <p className="contrast">{contrast}</p> : null}
            <div className="grid-cards" style={{ '--cols': cols(lensCards.length) }}>
              {lensCards}
            </div>
          </section>
        ) : null}

        <section className="band">
          <h2 className="label">The arguments, with evidence</h2>
          <div className="grid-cards" style={{ '--cols': cols(angleCards.length) }}>
            {angleCards}
          </div>
        </section>

        <footer className="foot">
          <details id="sources">
            <summary>Sources ({sourceItems.length})</summary>
            <ol>{sourceItems}</ol>
          </details>
          <details>
            <summary>
              {checks?.pass ? 'Passed' : 'Needs review'}: every citation, quote and number checked against the collected posts and comments
              {checkNotes.length ? ` · ${plural(checkNotes.length, 'note')}` : ''}
            </summary>
            {checkNotes.length ? (
              <ul>
                {checkNotes.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            ) : null}
          </details>
        </footer>
      </article>
      <OpenSourcesOnCite />
    </main>
  );
}
