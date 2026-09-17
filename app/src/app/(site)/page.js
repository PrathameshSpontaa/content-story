import Link from 'next/link';
import { listPlans, listPriceList } from '../../../lib/accounts.js';
import { fmtNum } from '../../../lib/format.js';
import { TOPUP_PACKS, TRIAL } from '../../../lib/pricing.js';
import { isSignedIn } from '../../../lib/session.js';
import { getTotals } from '../../../lib/stories.js';
import Icon from '../components/icons.js';
import RateCard from '../components/rate-card.js';

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
  { q: 'How did our launch land, and on which platform?', who: 'Brands and marketing teams', what: 'See how a launch, a campaign or a competitor lands with the audiences of the creators you work with, the week it happens.' },
  { q: 'Can I send the client something with sources?', who: 'Agencies', what: 'Keep every client’s creators in one workspace, and send a cross-platform report instead of a folder of screenshots.' },
  { q: 'What’s the whole conversation, not just the loud post?', who: 'Media and newsletter writers', what: 'Start from every side of the story, with every source linked, and copy a summary with citations straight into your draft.' },
];

const FAQ = [
  ['Which platforms do you read?', 'X, YouTube, LinkedIn, Instagram, TikTok and Reddit. A creator is followed on every platform they post to, and a subreddit counts as one source.'],
  [
    'How often does it update?',
    'The posts of who you follow are collected every day, and you can refresh on demand. Your stories are made only from who you follow, and nobody else sees them.',
  ],
  [
    'What is a credit?',
    'One unit that covers collecting the posts and comments, the AI steps and the checks. Following a creator costs 20 credits a day, a brand or topic 40, and a story report between 300 and 800, quoted before it runs. You see the cost before anything is spent.',
  ],
  ['Do you show commenters’ names?', 'No. Quotes are short, linked to their source, and usernames are hidden by default. The Contact page explains how to ask for a removal.'],
  [
    'How is this different from social listening?',
    'Listening tools count mentions and score sentiment. Content-Story reads the actual posts and comments, joins them into one story, and tells you what each platform’s audience concluded, with the counts and the quotes to prove it.',
  ],
];

export default async function Landing() {
  // Stories are private to each workspace, so the public page shows none.
  const [totals, plans, prices, signedIn] = await Promise.all([getTotals(), listPlans(), listPriceList(), isSignedIn()]);
  const start = signedIn ? { href: '/stories', label: 'Open your stories' } : { href: '/sign-up', label: `Start with ${fmtNum(TRIAL.credits)} free credits` };
  const planHref = signedIn ? '/billing' : '/sign-up';

  return (
    <main className="landing">
      <section className="ld-hero" id="story">
        <div className="ld-wrap">
          <div className="ld-hero-top">
            <div>
              <p className="ld-label">For brands, agencies and newsletter writers · India</p>
              <h1>
                <span className="ld-rise" style={{ animationDelay: '.05s' }}>
                  Six platforms.
                </span>{' '}
                <span className="ld-rise" style={{ animationDelay: '.2s' }}>
                  One <em className="ld-em">sheet.</em>
                </span>
              </h1>
            </div>
            <div>
              <p className="ld-lede">
                Content-Story follows the creators your audience listens to on X, YouTube, LinkedIn, Instagram, TikTok and Reddit, joins their posts into one story, and
                lays every platform’s verdict side by side, with every quote linked to its source.
              </p>
              <div className="ld-cta">
                <Link className="btn primary lg" href={start.href}>
                  {start.label}
                  <Icon name="arrow" size={17} />
                </Link>
                <Link className="btn ghost lg" href="#how">
                  How it works
                </Link>
              </div>
              <p className="ld-fine">
                No card needed. Beta prices in rupees. So far: {fmtNum(totals.posts)} posts and {fmtNum(totals.comments)} comments read.
              </p>
            </div>
          </div>

        </div>
      </section>

      <section className="ld-section" id="how">
        <div className="ld-wrap">
          <header className="ld-head">
            <p className="ld-label">How it works</p>
            <h2 className="ld-h2">
              Follow. <em className="ld-em">Join.</em> Check.
            </h2>
            <p className="ld-sub">Three steps, and the third one is the reason you can forward a story to a client without re-reading every comment.</p>
          </header>
          <ol className="ld-how">
            {STEPS.map((step, i) => (
              <li key={step.title}>
                <span className="n">{i + 1}</span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="ld-section">
        <div className="ld-wrap ld-proof">
          <div>
            <p className="ld-label">The rule the whole product is built on</p>
            <h2 className="ld-h2">
              AI writes. <em className="ld-em">Code counts.</em>
            </h2>
            <p className="ld-sub">
              If a number on a story page didn’t come from code, it’s a bug. Every citation names the post or comment it came from, and a story only publishes
              when every check passes.
            </p>
          </div>
        </div>
      </section>

      <section className="ld-section">
        <div className="ld-wrap">
          <header className="ld-head">
            <p className="ld-label">Who it’s for</p>
            <h2 className="ld-h2">
              One question each. <em className="ld-em">Answered by breakfast.</em>
            </h2>
          </header>
          <div className="ld-aud">
            {AUDIENCES.map((a) => (
              <article key={a.who}>
                <p className="q">“{a.q}”</p>
                <h3>{a.who}</h3>
                <p>{a.what}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="ld-section" id="pricing">
        <div className="ld-wrap">
          <header className="ld-head">
            <p className="ld-label">Pricing · beta · rate card</p>
            <h2 className="ld-h2">
              Pay for what <em className="ld-em">you follow.</em>
            </h2>
            <p className="ld-sub">
              One credit covers collection, AI and checking. Following a creator costs {prices.track_creator_day?.credits ?? 20} credits a day, a brand or topic{' '}
              {prices.track_keyword_day?.credits ?? 40}, and a story report 300–800, quoted before it runs.
            </p>
          </header>
          <RateCard plans={plans} trial={TRIAL} prices={prices} startHref={signedIn ? '/stories' : '/sign-up'} planHref={planHref} />
          <p className="ld-packs">
            Need more some months? Top up any time:
            {TOPUP_PACKS.map((n, i) => (
              <span key={n}>
                {fmtNum(n)}
                {i === TOPUP_PACKS.length - 1 ? ' credits' : ''}
              </span>
            ))}
          </p>
          <p className="ld-legal">Beta prices in rupees, plus GST. Plans renew monthly and can be changed from Billing. Credits pay for what you use; nothing is collected for a creator you stop following.</p>
        </div>
      </section>

      <section className="ld-section">
        <div className="ld-wrap">
          <header className="ld-head">
            <p className="ld-label">Questions</p>
            <h2 className="ld-h2">
              Before <em className="ld-em">you start.</em>
            </h2>
          </header>
          <div className="ld-faq">
            {FAQ.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="ld-band">
        <div className="ld-wrap ld-band-in">
          <div>
            <h2>
              Read the whole conversation, <em className="ld-em">not every post.</em>
            </h2>
            <p>{fmtNum(TRIAL.credits)} free credits. No card. Your first stories in about a minute.</p>
          </div>
          <Link className="btn invert lg" href={start.href}>
            {signedIn ? 'Open your stories' : 'Start free'}
            <Icon name="arrow" size={17} />
          </Link>
        </div>
      </section>
    </main>
  );
}
