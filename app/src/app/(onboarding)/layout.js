import { requireSession } from '../../../lib/session.js';
import Brand from '../components/brand-mark.js';
import { skipOnboardingAction } from './welcome/actions.js';

export const dynamic = 'force-dynamic';

export default async function OnboardingLayout({ children }) {
  await requireSession();
  return (
    <div className="ob-shell">
      <header className="ob-top">
        <Brand href="/stories" />
        <form action={skipOnboardingAction}>
          <button type="submit" className="linkbtn quiet">
            Skip for now
          </button>
        </form>
      </header>
      <main className="ob-main">{children}</main>
    </div>
  );
}
