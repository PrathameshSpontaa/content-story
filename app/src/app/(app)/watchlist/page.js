import { getPlanState, listPriceList } from '../../../../lib/accounts.js';
import { getBalance } from '../../../../lib/credits.js';
import { PLATFORM_NAMES, fmtNum, plural } from '../../../../lib/format.js';
import { PLATFORMS } from '../../../../lib/pricing.js';
import { requireSession } from '../../../../lib/session.js';
import { CREATOR_PLATFORMS, DAILY_ACTION, dailyCredits, listTargets } from '../../../../lib/watchlist.js';
import ActionForm from '../../components/action-form.js';
import { addCreatorAction, addTopicAction, removeAction, setActiveAction } from './actions.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Watchlist' };

const KIND_LABEL = { creator: 'Creator', keyword: 'Brand or keyword', community: 'Subreddit' };
const PLACEHOLDER = {
  x: '@handle or x.com/handle',
  youtube: '@handle or youtube.com/@handle',
  linkedin: 'linkedin.com/in/name',
  instagram: '@handle or instagram.com/handle',
  tiktok: '@handle or tiktok.com/@handle',
};

function TargetRow({ target, price }) {
  const title = target.kind === 'creator' ? target.creator_name : target.query;
  const found =
    target.kind === 'keyword'
      ? `mentioned in ${plural(target.stories, 'story', 'stories')}`
      : `${plural(target.posts_collected, 'post')} collected · in ${plural(target.stories, 'story', 'stories')}`;
  return (
    <li className={`target${target.active ? '' : ' paused'}`}>
      <div className="target-main">
        <span className="kind-pill">{KIND_LABEL[target.kind]}</span>
        <b>{title}</b>
        <span className="target-where">
          {target.kind === 'creator'
            ? target.handles.map((h) => (
                <a key={h.platform} href={h.url} target="_blank" rel="noopener noreferrer">
                  {PLATFORM_NAMES[h.platform]} {h.handle}
                </a>
              ))
            : target.platforms.map((p) => PLATFORM_NAMES[p]).join(' · ')}
        </span>
      </div>
      <span className="target-found">{found}</span>
      <span className="target-cost">{target.active ? `${price} credits/day` : 'Paused'}</span>
      <div className="target-actions">
        <form action={setActiveAction}>
          <input type="hidden" name="id" value={target.id} />
          <input type="hidden" name="active" value={String(!target.active)} />
          <button type="submit" className="btn ghost sm">
            {target.active ? 'Pause' : 'Resume'}
          </button>
        </form>
        <form action={removeAction}>
          <input type="hidden" name="id" value={target.id} />
          <button type="submit" className="btn ghost sm danger">
            Remove
          </button>
        </form>
      </div>
    </li>
  );
}

export default async function WatchlistPage() {
  const session = await requireSession();
  const workspaceId = session.workspace.id;
  const [targets, plan, prices, credits] = await Promise.all([listTargets(workspaceId), getPlanState(workspaceId), listPriceList(), getBalance(workspaceId)]);
  const perDay = dailyCredits(targets, prices);
  const sources = targets.filter((t) => t.active && t.kind !== 'keyword').length;
  const keywords = targets.filter((t) => t.active && t.kind === 'keyword').length;
  const daysLeft = perDay ? Math.floor(credits.available / perDay) : null;
  const collecting = process.env.COLLECTION_ENABLED === 'true';

  return (
    <main className="apppage">
      <header className="pagehead">
        <h1>Watchlist</h1>
        <p className="dek">Creators, brands and subreddits you follow. Stories that involve them collect in your feed under “From your watchlist”.</p>
      </header>

      <dl className="stats">
        <div>
          <dt>Creators and subreddits</dt>
          <dd>
            {sources} <small>of {plan.maxSources}</small>
          </dd>
        </div>
        <div>
          <dt>Brands and keywords</dt>
          <dd>
            {keywords} <small>of {plan.maxKeywords}</small>
          </dd>
        </div>
        <div>
          <dt>Daily cost when collecting</dt>
          <dd>
            {fmtNum(perDay)} <small>credits</small>
          </dd>
        </div>
        <div>
          <dt>Credits last</dt>
          <dd>{daysLeft === null ? <small>nothing tracked</small> : <>{fmtNum(daysLeft)} <small>{daysLeft === 1 ? 'day' : 'days'}</small></>}</dd>
        </div>
      </dl>

      {collecting ? null : (
        <p className="notice info">
          Daily collection is in beta. Your watchlist is saved and matched against the stories we already cover. Automatic daily collection, and its credit charges,
          start when we switch it on for your workspace; nothing is charged until then.
        </p>
      )}

      {targets.length ? (
        <ul className="targets">
          {targets.map((t) => (
            <TargetRow key={t.id} target={t} price={prices[DAILY_ACTION[t.kind]]?.credits ?? 0} />
          ))}
        </ul>
      ) : (
        <div className="empty">
          <b>Nothing on your watchlist yet.</b>
          <span>Start with a creator you already follow. Paste their profile links; one platform is enough.</span>
        </div>
      )}

      <div className="addgrid">
        <section className="panel">
          <h2>Add a creator</h2>
          <p className="hint">One profile is enough. If we already collect this creator, we fill in their other platforms.</p>
          <ActionForm action={addCreatorAction} submitLabel="Add creator" pendingLabel="Adding…">
            <label className="field">
              <span>Name</span>
              <input name="name" placeholder="e.g. Varun Mayya" maxLength={80} autoComplete="off" />
            </label>
            {CREATOR_PLATFORMS.map((p) => (
              <label className="field" key={p}>
                <span>{PLATFORM_NAMES[p]}</span>
                <input name={p} placeholder={PLACEHOLDER[p]} autoComplete="off" spellCheck={false} />
              </label>
            ))}
          </ActionForm>
        </section>

        <section className="panel">
          <h2>Add a brand, keyword or subreddit</h2>
          <p className="hint">Brands and keywords are searched on the platforms you pick. Subreddits are followed on Reddit.</p>
          <ActionForm action={addTopicAction} submitLabel="Add to watchlist" pendingLabel="Adding…">
            <fieldset className="field">
              <legend>What is it?</legend>
              <label className="choice">
                <input type="radio" name="kind" value="keyword" defaultChecked /> Brand or keyword · {prices.track_keyword_day?.credits ?? 0} credits/day
              </label>
              <label className="choice">
                <input type="radio" name="kind" value="community" /> Subreddit · {prices.track_community_day?.credits ?? 0} credits/day
              </label>
            </fieldset>
            <label className="field">
              <span>Name</span>
              <input name="query" placeholder="e.g. boAt, Gemini 3, r/IndianGaming" maxLength={60} autoComplete="off" required />
            </label>
            <fieldset className="field">
              <legend>Platforms to search</legend>
              <div className="checks">
                {PLATFORMS.map((p) => (
                  <label className="choice" key={p}>
                    <input type="checkbox" name="platforms" value={p} defaultChecked /> {PLATFORM_NAMES[p]}
                  </label>
                ))}
              </div>
            </fieldset>
          </ActionForm>
        </section>
      </div>

      <p className="pagefoot">
        Limits come from your plan ({plan.name}). Paused entries don’t count toward them and aren’t charged.
      </p>
    </main>
  );
}
