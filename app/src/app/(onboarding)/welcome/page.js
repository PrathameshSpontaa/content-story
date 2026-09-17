import { getPlanState } from '../../../../lib/accounts.js';
import { USE_CASES, getCatalog } from '../../../../lib/catalog.js';
import { requireSession } from '../../../../lib/session.js';
import Onboarding from '../../components/onboarding.js';
import { finishOnboardingAction } from './actions.js';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Set up your stories' };

export default async function WelcomePage() {
  const session = await requireSession();
  const workspaceId = session.workspace.id;
  const [{ creators, communities, topics }, plan] = await Promise.all([getCatalog(workspaceId), getPlanState(workspaceId)]);

  return (
    <Onboarding
      firstName={(session.user.name ?? '').split(' ')[0]}
      useCases={USE_CASES}
      creators={creators}
      communities={communities}
      topics={topics}
      limits={{ maxSources: plan.maxSources, maxKeywords: plan.maxKeywords, planName: plan.name }}
      initialUseCase={session.workspace.useCase}
      finish={finishOnboardingAction}
    />
  );
}
