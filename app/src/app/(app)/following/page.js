import Link from 'next/link';
import { getPlanState } from '../../../../lib/accounts.js';
import { getFollowing } from '../../../../lib/following.js';
import { getRefreshStatus } from '../../../../lib/refresh.js';
import { requireSession } from '../../../../lib/session.js';
import { CREATOR_PLATFORMS } from '../../../../lib/profiles.js';
import { listWatchlists } from '../../../../lib/watchlists.js';
import { chosenWatchlistIds } from '../../watchlist-choice.js';
import ChannelGaps from './channel-gaps.js';
import FollowingView from './following-view.js';
import WatchlistPicker from './watchlist-picker.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Following' };

export default async function FollowingPage() {
  const session = await requireSession();
  const workspaceId = session.workspace.id;
  // Watchlists first: the first one is made here for a workspace that has none yet, once onboarding has
  // said what the workspace is for (that picks its tags).
  const watchlists = session.workspace.onboardedAt ? await listWatchlists(workspaceId) : [];
  const [data, plan, refreshStatus, chosen] = await Promise.all([getFollowing(workspaceId), getPlanState(workspaceId), getRefreshStatus(workspaceId), chosenWatchlistIds()]);
  // Followed creators we only have some platforms for, and never looked for the rest.
  const gaps = data.sources
    .filter((s) => s.kind === 'creator' && s.follow?.active && !s.channelsChecked && s.handles.length < CREATOR_PLATFORMS.length)
    .map((s) => ({ creatorId: s.creatorId, name: s.name, handles: s.handles }));
  const chosenId = watchlists.find((w) => w.id === chosen[0])?.id ?? watchlists[0]?.id;

  return (
    <div className="page">
      <header className="pagehead">
        <h1>Following</h1>
        <p>
          Everyone you follow, across your <Link href="/watchlists">watchlists</Link>. Each watchlist makes its own stories from the people in it. Numbers are for
          the last 7 days.
        </p>
      </header>
      {watchlists.length ? <WatchlistPicker watchlists={watchlists.map((w) => ({ id: w.id, name: w.name }))} chosenId={chosenId} /> : null}
      <ChannelGaps creators={gaps} />
      <FollowingView
        sources={data.sources}
        keywords={data.keywords}
        totalStories={data.totalStories}
        plan={{ name: plan.name, maxSources: plan.maxSources, maxKeywords: plan.maxKeywords }}
        refreshStatus={refreshStatus}
      />
    </div>
  );
}
