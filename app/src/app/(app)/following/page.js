import Link from 'next/link';
import { getPlanState } from '../../../../lib/accounts.js';
import { getFollowing } from '../../../../lib/following.js';
import { getRefreshStatus } from '../../../../lib/refresh.js';
import { requireSession } from '../../../../lib/session.js';
import { CREATOR_PLATFORMS } from '../../../../lib/profiles.js';
import ChannelGaps from './channel-gaps.js';
import FollowingView from './following-view.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Following' };

export default async function FollowingPage() {
  const session = await requireSession();
  const workspaceId = session.workspace.id;
  const [data, plan, refreshStatus] = await Promise.all([getFollowing(workspaceId), getPlanState(workspaceId), getRefreshStatus(workspaceId)]);
  // Followed creators we only have some platforms for, and never looked for the rest.
  const gaps = data.sources
    .filter((s) => s.kind === 'creator' && s.follow?.active && !s.channelsChecked && s.handles.length < CREATOR_PLATFORMS.length)
    .map((s) => ({ creatorId: s.creatorId, name: s.name, handles: s.handles }));

  return (
    <div className="page">
      <header className="pagehead">
        <h1>Following</h1>
        <p>
          Stories that involve these creators, subreddits and brands appear in <Link href="/stories?tab=foryou">Your stories</Link>. Numbers are for the last 7 days.
        </p>
      </header>
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
