import Link from 'next/link';
import { getPlanState } from '../../../../lib/accounts.js';
import { getFollowing } from '../../../../lib/following.js';
import { getRefreshStatus } from '../../../../lib/refresh.js';
import { requireSession } from '../../../../lib/session.js';
import FollowingView from './following-view.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Following' };

export default async function FollowingPage() {
  const session = await requireSession();
  const workspaceId = session.workspace.id;
  const [data, plan, refreshStatus] = await Promise.all([getFollowing(workspaceId), getPlanState(workspaceId), getRefreshStatus(workspaceId)]);

  return (
    <div className="page">
      <header className="pagehead">
        <h1>Following</h1>
        <p>
          Stories that involve these creators, subreddits and brands appear in <Link href="/stories?tab=foryou">Your stories</Link>. Numbers are for the last 7 days.
        </p>
      </header>
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
