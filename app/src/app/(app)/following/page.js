import Link from 'next/link';
import { getPlanState, listPriceList } from '../../../../lib/accounts.js';
import { getCatalog } from '../../../../lib/catalog.js';
import { PLATFORM_NAMES, plural } from '../../../../lib/format.js';
import { requireSession } from '../../../../lib/session.js';
import ActionForm from '../../components/action-form.js';
import Avatar from '../../components/avatar.js';
import CreatorFinder from '../../components/creator-finder.js';
import Icon from '../../components/icons.js';
import PlatformMark from '../../components/platform-mark.js';
import SubmitButton from '../../components/submit-button.js';
import { addTopicAction, followCreatorAction, followTopicAction, unfollowAction } from './actions.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Following' };

const reach = (item, noun) =>
  item.story_ids.length ? `In ${plural(item.story_ids.length, 'story', 'stories')} this week` : item.posts ? `${plural(item.posts, noun)} this week, no stories yet` : 'Not collected yet';

function Meter({ label, used, max }) {
  const pct = Math.min(100, Math.round((used / Math.max(1, max)) * 100));
  return (
    <div className={`meter${used >= max ? ' full' : ''}`}>
      <div className="meter-top">
        <span>{label}</span>
        <b>
          {used} <small>of {max}</small>
        </b>
      </div>
      <span className="meter-track" aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

function Unfollow({ targetId, name }) {
  return (
    <form action={unfollowAction}>
      <input type="hidden" name="id" value={targetId} />
      <SubmitButton className="btn ghost sm following-btn" pendingLabel="Saving…" title={`Unfollow ${name}`}>
        <span className="when-idle">
          <Icon name="check" size={14} /> Following
        </span>
        <span className="when-hover">Unfollow</span>
      </SubmitButton>
    </form>
  );
}

function PersonCard({ creator, full }) {
  return (
    <article className={`person${creator.target_id ? ' on' : ''}`}>
      <Avatar name={creator.name} size="lg" />
      <div className="person-body">
        <b>{creator.name}</b>
        <span className="marks">
          {creator.handles.map((h) => (
            <a key={h.platform} href={h.url} target="_blank" rel="noopener noreferrer" title={`${PLATFORM_NAMES[h.platform]} ${h.handle}`}>
              <PlatformMark platform={h.platform} size="xs" />
            </a>
          ))}
        </span>
        <span className="person-meta">{reach(creator, 'post')}</span>
      </div>
      {creator.target_id ? (
        <Unfollow targetId={creator.target_id} name={creator.name} />
      ) : (
        <form action={followCreatorAction}>
          <input type="hidden" name="creatorId" value={creator.id} />
          <SubmitButton className="btn primary sm" pendingLabel="Following…" disabled={full} title={full ? 'You’ve reached your plan’s limit' : undefined}>
            Follow
          </SubmitButton>
        </form>
      )}
    </article>
  );
}

function CommunityCard({ community, full }) {
  return (
    <article className={`person${community.target_id ? ' on' : ''}`}>
      <Avatar name={community.name} kind="community" size="lg" />
      <div className="person-body">
        <b>{community.name}</b>
        <span className="person-meta">{reach(community, 'thread')}</span>
      </div>
      {community.target_id ? (
        <Unfollow targetId={community.target_id} name={community.name} />
      ) : (
        <form action={followTopicAction}>
          <input type="hidden" name="kind" value="community" />
          <input type="hidden" name="query" value={community.name} />
          <SubmitButton className="btn primary sm" pendingLabel="Following…" disabled={full} title={full ? 'You’ve reached your plan’s limit' : undefined}>
            Follow
          </SubmitButton>
        </form>
      )}
    </article>
  );
}

export default async function FollowingPage() {
  const session = await requireSession();
  const workspaceId = session.workspace.id;
  const [{ creators, communities, topics }, plan, prices] = await Promise.all([getCatalog(workspaceId), getPlanState(workspaceId), listPriceList()]);

  const followedCreators = creators.filter((c) => c.target_id);
  const suggestedCreators = creators.filter((c) => !c.target_id);
  const sourcesUsed = followedCreators.length + communities.filter((c) => c.target_id).length;
  const followedTopics = topics.filter((t) => t.target_id);
  const suggestedTopics = topics.filter((t) => !t.target_id);
  const sourcesFull = sourcesUsed >= plan.maxSources;
  const topicsFull = followedTopics.length >= plan.maxKeywords;

  return (
    <div className="page">
      <header className="pagehead">
        <h1>Following</h1>
        <p>
          Stories that involve these creators, subreddits and brands appear in <Link href="/stories?tab=foryou">Your stories</Link>.
        </p>
      </header>

      <div className="usage panel">
        <Meter label="Creators and subreddits" used={sourcesUsed} max={plan.maxSources} />
        <Meter label="Brands and topics" used={followedTopics.length} max={plan.maxKeywords} />
        <p className="usage-note">
          {plan.name}. Following is free while daily collection is in beta. After that it uses credits each day: {prices.track_creator_day?.credits ?? 20} per creator or
          subreddit and {prices.track_keyword_day?.credits ?? 40} per brand or topic.
        </p>
      </div>

      <section className="fsection" aria-labelledby="h-creators">
        <div className="fsection-head">
          <h2 id="h-creators">Creators</h2>
          <p>{followedCreators.length ? `You follow ${followedCreators.length}` : 'Follow the people your audience listens to'}</p>
        </div>
        <CreatorFinder mode="follow" />

        {followedCreators.length ? (
          <>
            <h3 className="sublabel">You follow</h3>
            <div className="people">
              {followedCreators.map((c) => (
                <PersonCard key={c.id} creator={c} full={sourcesFull} />
              ))}
            </div>
          </>
        ) : null}
        {suggestedCreators.length ? (
          <>
            <h3 className="sublabel">Already covered</h3>
            <div className="people">
              {suggestedCreators.map((c) => (
                <PersonCard key={c.id} creator={c} full={sourcesFull} />
              ))}
            </div>
          </>
        ) : null}
      </section>

      <section className="fsection" aria-labelledby="h-subs">
        <div className="fsection-head">
          <h2 id="h-subs">Subreddits</h2>
          <p>Where audiences argue it out</p>
        </div>
        <div className="people compact">
          {communities.map((c) => (
            <CommunityCard key={c.name} community={c} full={sourcesFull} />
          ))}
        </div>
        <ActionForm action={addTopicAction} submitLabel="Follow" pendingLabel="Adding…" className="inlineadd" variant="ghost">
          <input type="hidden" name="kind" value="community" />
          <label className="field">
            <span className="sr">Subreddit</span>
            <input name="query" placeholder="Follow another subreddit, like r/IndianGaming" required maxLength={80} autoComplete="off" />
          </label>
        </ActionForm>
      </section>

      <section className="fsection" aria-labelledby="h-topics">
        <div className="fsection-head">
          <h2 id="h-topics">Brands and topics</h2>
          <p>We flag stories that mention them on any platform</p>
        </div>
        {followedTopics.length ? (
          <ul className="topics">
            {followedTopics.map((t) => (
              <li key={t.name} className="topic">
                <span className="topic-name">{t.name}</span>
                <span className="topic-meta">{t.story_ids.length ? plural(t.story_ids.length, 'story', 'stories') : 'no stories yet'}</span>
                <form action={unfollowAction}>
                  <input type="hidden" name="id" value={t.target_id} />
                  <SubmitButton className="iconbtn sm" title={`Unfollow ${t.name}`}>
                    <Icon name="close" size={14} />
                    <span className="sr">Unfollow {t.name}</span>
                  </SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted-note">You don’t follow any brands or topics yet. Add your own brand, a competitor or a product.</p>
        )}
        <ActionForm action={addTopicAction} submitLabel="Follow" pendingLabel="Adding…" className="inlineadd" variant="ghost">
          <input type="hidden" name="kind" value="keyword" />
          <label className="field">
            <span className="sr">Brand or topic</span>
            <input name="query" placeholder="Your brand, a competitor or a product" required maxLength={60} autoComplete="off" />
          </label>
        </ActionForm>
        {suggestedTopics.length ? (
          <>
            <p className="suggest-label">In this week’s stories</p>
            <div className="suggest">
              {suggestedTopics.map((t) => (
                <form key={t.name} action={followTopicAction}>
                  <input type="hidden" name="kind" value="keyword" />
                  <input type="hidden" name="query" value={t.name} />
                  <SubmitButton className="suggest-chip" disabled={topicsFull} title={topicsFull ? 'You’ve reached your plan’s limit' : `Follow ${t.name}`}>
                    <Icon name="plus" size={13} />
                    {t.name}
                    {t.story_ids.length ? <span className="suggest-n">{t.story_ids.length}</span> : null}
                  </SubmitButton>
                </form>
              ))}
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
