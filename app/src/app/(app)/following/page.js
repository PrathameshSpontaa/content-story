import Link from 'next/link';
import { getPlanState } from '../../../../lib/accounts.js';
import { dayRange } from '../../../../lib/format.js';
import { getFollowing } from '../../../../lib/following.js';
import { requireSession } from '../../../../lib/session.js';
import FollowingView from './following-view.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Following' };

export default async function FollowingPage() {
  const session = await requireSession();
  const workspaceId = session.workspace.id;
  const [data, plan] = await Promise.all([getFollowing(workspaceId), getPlanState(workspaceId)]);

  return (
    <div className="page">
      <header className="pagehead">
        <h1>Following</h1>
        <p>
          Stories that involve these creators, subreddits and brands appear in <Link href="/stories?tab=all">Your stories</Link>. Numbers are for {dayRange(data.week.start, data.week.end)}.
        </p>
      </header>
      <FollowingView sources={data.sources} keywords={data.keywords} totalStories={data.totalStories} plan={{ name: plan.name, maxSources: plan.maxSources, maxKeywords: plan.maxKeywords }} />
    </div>
  );
}
