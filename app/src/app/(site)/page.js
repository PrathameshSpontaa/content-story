import Link from 'next/link';
import { listPlans, listPriceList } from '../../../lib/accounts.js';
import { PLATFORM_NAMES, dayRange, fmtNum, plural } from '../../../lib/format.js';
import { TRIAL, fmtINR } from '../../../lib/pricing.js';
import { isSignedIn } from '../../../lib/session.js';
import { getFeed, getTotals } from '../../../lib/stories.js';

export const dynamic = 'force-dynamic';

const STEPS = [
  {
    title: 'We watch the people your audience listens to',
    text: 'Creators’ posts on six platforms, plus the comments under the posts that take off, collected every day.',
  },
  {
    title: 'We connect posts into stories',
    text: 'A launch, a controversy, a deal: posts from different creators and platforms about the same thing become one story with a main character, a timeline and the arguments on each side.',
  },
  {
    title: 'We check before anything is published',
    text: 'AI writes the story; code checks it. Every citation must point at a real post or comment, every quote must appear word for word, and every percentage is counted, not generated.',
  },
];

const AUDIENCES = [
  { who: 'Brands and marketing teams', what: 'See how launches, campaigns and competitors land with the audiences of the creators you work with, the week it happens.' },
  { who: 'Agencies', what: 'Watch every client’s creator roster in one place, and send a cross-platform report instead of a folder of screenshots.' },
  { who: 'Media and newsletter writers', what: 'Start from the whole conversation, with a link to every source, and copy a summary with its citations.' },
];

export default async function Landing() {
  const [stories, totals, plans, prices, signedIn] = await Promise.all([getFeed(), getTotals(), listPlans(), listPriceList(), isSignedIn()]);
  const specimen = stories.find((s) => !s.whyNotTop && s.platform_strip.length >= 3) ?? stories[0];
  const others = stories.filter((s) => s !== specimen).slice(0, 4);
  const start = signedIn ? { href: '/feed', label: 'Open your feed' } : { href: '/sign-up', label: `Start free with ${fmtNum(TRIAL.credits)} credits` };
  const perDay = (action) => prices[action]?.credits ?? 0;

  return (
    <main className="landing">
      <section className="lhero">
        <div className="lhero-copy">
          <p className="eyebrow">X · YouTube · LinkedIn · Instagram · TikTok · Reddit</p>
          <h1>One story. Six platforms. Every side of it.</h1>
          <p className="lede">
            Content-Story reads what creators post and how their audiences answer, groups it into stories, and shows what each platform is actually saying.
            Every quote and number is checked against the post it came from.
          </p>
          <div className="cta">
            <Link className="btn primary lg" href={start.href}>
              {start.label}
            </Link>
            <Link className="btn ghost lg" href="#how">
              How it works
            </Link>
          </div>
          <p className="fine">
            No card needed. This week’s feed: {fmtNum(totals.posts)} posts and {fmtNum(totals.comments)} comments, {plural(stories.length, 'story', 'stories')}.
          </p>
        </div>

        {specimen ? (
          <figure className="specimen">
            <figcaption className="eyebrow">From this week’s feed · {dayRange(specimen.first_post_at, specimen.last_post_at)}</figcaption>
            <div className="scard">
              <p className="eyebrow">
                <span className="mc">{specimen.main_character}</span> · {specimen.category}
              </p>
              <h3>{specimen.headline}</h3>
              {specimen.dek ? <p className="dek">{specimen.dek}</p> : null}
              <ul className="strip">
                {specimen.platform_strip.map((s) => (
                  <li key={s.platform}>
                    <b>{PLATFORM_NAMES[s.platform] ?? s.platform}</b>
                    <span>{s.gist}</span>
                  </li>
                ))}
              </ul>
              <p className="cov">
                {plural(specimen.sources ?? specimen.creators, 'source')} · {plural(specimen.platforms, 'platform')} ·{' '}
                {specimen.audience ? plural(specimen.audience, 'comment') : 'no comments yet'} · heat {specimen.heat}
              </p>
            </div>
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

      {others.length ? (
        <section className="lsection">
          <h2 className="lh2">Also in this week’s feed</h2>
          <ul className="headlines">
            {others.map((s) => (
              <li key={s.id}>
                <span className="eyebrow">
                  <span className="mc">{s.main_character}</span> · {s.category}
                </span>
                <b>{s.headline}</b>
                <span className="heatnum" title="Heat">
                  {s.heat}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="lsection" id="pricing">
        <h2 className="lh2">Pricing</h2>
        <p className="lede narrow">Plans include credits every month. Credits pay for what you use, so a small watchlist costs little and a busy agency pays for what it tracks.</p>
        <div className="rates">
          <div>
            <b>{perDay('track_creator_day')}</b>
            <span>credits a day to track a creator on all their platforms</span>
          </div>
          <div>
            <b>{perDay('track_keyword_day')}</b>
            <span>credits a day to track a brand or keyword</span>
          </div>
          <div>
            <b>{perDay('track_community_day')}</b>
            <span>credits a day to track a subreddit</span>
          </div>
          <div>
            <b>300–800</b>
            <span>credits for a story report, quoted before it runs</span>
          </div>
        </div>
        <div className="plans">
          <div className="plan">
            <h3>Free trial</h3>
            <p className="price">
              {fmtINR(0)}
              <small> once</small>
            </p>
            <ul>
              <li>{fmtNum(TRIAL.credits)} credits</li>
              <li>{plural(TRIAL.maxSources, 'creator or community', 'creators or communities')}</li>
              <li>{plural(TRIAL.maxKeywords, 'brand or keyword', 'brands or keywords')}</li>
              <li>The shared AI &amp; tech feed</li>
            </ul>
          </div>
          {plans.map((plan) => (
            <div className={`plan${plan.id === 'pro' ? ' lead' : ''}`} key={plan.id}>
              <h3>{plan.name}</h3>
              <p className="price">
                {fmtINR(plan.price_paise)}
                <small> a month + GST</small>
              </p>
              <ul>
                <li>{fmtNum(plan.credits_per_period)} credits a month</li>
                <li>{plural(plan.max_tracked_creators, 'creator or community', 'creators or communities')}</li>
                <li>{plural(plan.max_tracked_keywords, 'brand or keyword', 'brands or keywords')}</li>
                <li>{plural(plan.max_seats, 'seat')}</li>
              </ul>
            </div>
          ))}
        </div>
        <p className="fine">Beta prices in Indian rupees. Top-up credits are available on every plan.</p>
      </section>

      <section className="lband">
        <h2>Read the whole conversation, not every post.</h2>
        <Link className="btn primary lg" href={start.href}>
          {start.label}
        </Link>
      </section>
    </main>
  );
}
