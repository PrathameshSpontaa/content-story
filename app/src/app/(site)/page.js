import Link from 'next/link';
import { listPlans, listPriceList } from '../../../lib/accounts.js';
import { fmtNum, plural } from '../../../lib/format.js';
import { TRIAL, fmtINR } from '../../../lib/pricing.js';
import { isSignedIn } from '../../../lib/session.js';
import { getFeed, getTotals } from '../../../lib/stories.js';
import Icon from '../components/icons.js';
import StoryCard from '../components/story-card.js';

export const dynamic = 'force-dynamic';

const STEPS = [
  {
    title: 'Follow the voices your audience listens to',
    text: 'Pick creators, subreddits and brands. We read their posts on six platforms, and the comments under the ones that take off.',
  },
  {
    title: 'Posts become one story',
    text: 'A launch, a controversy, a deal: posts from different creators and platforms about the same thing are joined into one story, with a timeline and the arguments on each side.',
  },
  {
    title: 'Checked before you read it',
    text: 'AI writes the story; code checks it. Every citation points at a real post or comment, every quote appears word for word, and every percentage is counted.',
  },
];

const AUDIENCES = [
  { who: 'Brands and marketing teams', what: 'See how a launch, a campaign or a competitor lands with the audiences of the creators you work with, the week it happens.' },
  { who: 'Agencies', what: 'Keep every client’s creators in one place, and send a cross-platform report instead of a folder of screenshots.' },
  { who: 'Media and newsletter writers', what: 'Start from the whole conversation, with every source linked, and copy a summary straight into your draft.' },
];

export default async function Landing() {
  const [stories, totals, plans, prices, signedIn] = await Promise.all([getFeed(), getTotals(), listPlans(), listPriceList(), isSignedIn()]);
  const specimen = stories.find((s) => !s.whyNotTop && (s.platform_strip?.length ?? 0) >= 3) ?? stories[0];
  const start = signedIn ? { href: '/stories', label: 'Open your stories' } : { href: '/sign-up', label: 'Start free' };

  return (
    <main className="landing">
      <section className="lhero">
        <div className="lhero-copy">
          <p className="kicker">For brands, agencies and newsletter writers</p>
          <h1>Every platform’s take on the same story.</h1>
          <p className="lede">
            Content-Story follows the creators your audience listens to on X, YouTube, LinkedIn, Instagram, TikTok and Reddit, joins their posts into stories, and shows what
            each platform’s audience actually thinks, with every quote linked to its source.
          </p>
          <div className="cta">
            <Link className="btn primary lg" href={start.href}>
              {start.label}
              <Icon name="arrow" size={17} />
            </Link>
            <Link className="btn ghost lg" href="#how">
              How it works
            </Link>
          </div>
          <p className="fine">
            {fmtNum(TRIAL.credits)} free credits, no card needed. This week: {fmtNum(totals.posts)} posts and {fmtNum(totals.comments)} comments in{' '}
            {plural(stories.length, 'story', 'stories')}.
          </p>
        </div>

        {specimen ? (
          <figure className="specimen">
            <figcaption>
              <span className="live-dot" aria-hidden="true" />
              From this week’s stories
            </figcaption>
            <StoryCard story={{ ...specimen, tracked: [], saved: false }} variant="lead" />
          </figure>
        ) : null}
      </section>

      <section className="lsection" id="how">
        <h2 className="lh2">How it works</h2>
        <ol className="steps">
          {STEPS.map((step) => (
            <li key={step.title}>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="lsection">
        <h2 className="lh2">Who it’s for</h2>
        <div className="aud">
          {AUDIENCES.map((a) => (
            <div key={a.who}>
              <h3>{a.who}</h3>
              <p>{a.what}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="lsection" id="pricing">
        <h2 className="lh2">Pricing</h2>
        <div className="plans">
          <div className="plan">
            <h3>Free trial</h3>
            <p className="price">
              {fmtINR(0)}
              <small> to start</small>
            </p>
            <ul>
              <li>{fmtNum(TRIAL.credits)} credits</li>
              <li>{plural(TRIAL.maxSources, 'creator or subreddit', 'creators and subreddits')}</li>
              <li>{plural(TRIAL.maxKeywords, 'brand or topic', 'brands and topics')}</li>
              <li>Every story in the weekly feed</li>
            </ul>
          </div>
          {plans.map((plan) => (
            <div className={`plan${plan.id === 'pro' ? ' lead' : ''}`} key={plan.id}>
              <h3>
                {plan.name}
                {plan.id === 'pro' ? <span className="pill">Most teams</span> : null}
              </h3>
              <p className="price">
                {fmtINR(plan.price_paise)}
                <small> / month</small>
              </p>
              <ul>
                <li>{fmtNum(plan.credits_per_period)} credits every month</li>
                <li>{plural(plan.max_tracked_creators, 'creator or subreddit', 'creators and subreddits')}</li>
                <li>{plural(plan.max_tracked_keywords, 'brand or topic', 'brands and topics')}</li>
                <li>{plural(plan.max_seats, 'seat')}</li>
              </ul>
            </div>
          ))}
        </div>
        <p className="fine">
          Beta prices in rupees, plus GST. Credits pay for what you use: following costs {prices.track_creator_day?.credits ?? 20} credits a day per creator and{' '}
          {prices.track_keyword_day?.credits ?? 40} per brand once daily collection starts, and a story report costs 300–800 credits, quoted before it runs.
        </p>
      </section>

      <section className="lband">
        <h2>Read the whole conversation, not every post.</h2>
        <Link className="btn invert lg" href={start.href}>
          {start.label}
          <Icon name="arrow" size={17} />
        </Link>
      </section>
    </main>
  );
}
