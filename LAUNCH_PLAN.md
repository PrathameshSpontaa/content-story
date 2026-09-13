# Content-Story: from dry run to paid product

The dry run proved the pipeline: 188 real posts and 1,137 comments from six platforms
became 8 checked stories for $1.48 of Apify credit. This plan covers what's left to sell it:
a multi-user product for brands, agencies and media writers in India, paid through a
subscription with credits, running every day on Render with Gemini.

**Definition of launched:** paying customers can sign up, pay in INR with a GST invoice,
choose what to track, receive checked stories, alerts and digests, and spend credits that
match what their usage costs us. Everything runs on a schedule without manual steps, and
someone is alerted when it breaks.

Owner key: **You** = a decision, account or document only you can provide. **Claude** = build work.

## Build order

| Milestone | What | Needs from you | Status |
|---|---|---|---|
| M1 | Gemini replaces Claude for every AI step; side-by-side comparison on this week's data | Gemini API key ✓ | in progress: cards, comment groups and grouping done on Gemini; stories being written |
| M2 | Dry-run fixes rebuilt into the production pipeline (section 1) | none | next |
| M3 | Postgres: workspaces, tracking lists, stories, credit ledger with a fake payment provider | `DATABASE_URL` ✓; enable Razorpay Subscriptions | in progress: dev database `content-story-dev` live (Postgres 18, free, Singapore, expires 13 Oct 2026); schema migrated; credit ledger and billing pass 12/12 end-to-end checks on the real database; dry-run week imported (188 posts, 1,137 comments, 315 comment groups, 8 stories as the shared feed) and read back correctly; Razorpay test orders work, Subscriptions API not enabled yet |
| M4 | Web app on Render staging: sign-in, onboarding, feeds, reports, alerts, billing pages | Render access to the GitHub repo; Clerk keys; env vars on Render | in progress: live at content-story.onrender.com with Clerk sign-in. Built: landing page, legal drafts (terms, privacy, refunds, contact), accounts with 1,000 trial credits, feed filters, search, saved stories and a watchlist tab, watchlist (creators, brands/keywords, subreddits, plan limits), report requests that hold credits, billing (balance, credit history, Razorpay top-ups), settings (GSTIN, state), admin (report queue, story review, credit grants); 15/15 product checks. Not yet: alerts and digests, team invites, subscription checkout, daily collection |
| M5 | Private beta with design partners, price list calibrated | Design partners, legal review | |
| M6 | Paid launch: Razorpay live, name and domain | N1, N2, N3 | later |

---

## 0. Decisions

### Made

| # | Decision | Answer |
|---|---|---|
| D1 | Who it's for | Paid product |
| D2 | How usage is paid for | Credits: one unit that covers scraping + AI + hosting |
| D3 | AI in production | Gemini, after a side-by-side quality check against the Claude dry run |
| D4 | Hosting | Render |
| D5 | What credits pay for | Tracking your own creators, on-demand story reports, the shared feed, alerts and digests |
| D6 | How users pay | Monthly subscription that includes credits, plus top-up packs |
| D7 | First customers | Brands and marketing teams, agencies, media and newsletter writers |
| D8 | Market | India first: Razorpay (UPI, cards), GST invoices |

### Still needed from you (defaults in brackets)

| # | Need | Why it blocks |
|---|---|---|
| N1 | Registered business entity and GSTIN | Razorpay live mode and GST invoices require them |
| N2 | Razorpay account, KYC and API keys **(later)** | Billing is built against a payment interface and tested with a fake provider; Razorpay plugs in when the keys exist |
| N3 | Product name and domain **(later)** | Working name "Content-Story" until then; the name is read from one setting |
| N4 | Gemini API key on a **paid** billing account | Free-tier data can be used by Google and has tight limits; not acceptable for customer data. **Current key is on the free tier** (confirmed 13 Sep 2026: daily per-model request limit hit on gemini-3.8-flash) |
| N5 | Apify plan for production [upgrade when beta usage is known] | Usage grows with every tracked creator |
| N6 | 3–5 design partners (brands, agencies or writers) for a free beta | Pricing and features need real users before charging |
| N7 | Legal counsel | Scraped data used commercially, India's DPDP Act, terms, privacy and refund policy |
| N8 | Who approves stories during beta [you] | The review queue needs an owner |
| N9 | Schedule time zone [IST] | When daily runs and digests go out |
| N10 | Email sender for alerts and digests [Resend, on your domain] | Needs DNS access to your domain |
| N11 | Slack alerts at launch or later [later] | Adds a Slack app and approval |

---

## 1. Fix what the dry run exposed

- [ ] **Claude** · Story-driven comment pass: once posts form a story, collect 100+ top comments on each of its posts (capped per run).
- [ ] **Claude** · Entity alias table so "Astra" and "GPT-6 Astra" count as one.
- [ ] **Claude** · Code check that flags split stories (shared main entity, overlapping dates) for a merge decision.
- [ ] **Claude** · Main-character check against the top claim subjects.
- [ ] **Claude** · Enforce length limits (headline ≤ 12 words, narrative ≤ 5 sentences) and re-run only the failing step.
- [ ] **Claude** · Turning points from real comment timestamps; heat re-tuned for a daily feed.
- [ ] **Claude** · Brand and keyword tracking: search-based collection (X search, Reddit search, YouTube search, TikTok hashtags) so brands can track mentions, not just creators.

## 2. Production pipeline (Gemini, multi-user)

- [ ] **Claude** · Replace the Claude-agent steps with Gemini API calls: JSON-schema output, retries, batch pricing for bulk steps, per-call cost logging.
- [ ] **Claude** · Side-by-side: run this week's data through Gemini and compare story by story with the dry run. **You** approve before switching.
- [ ] **Claude** · Move from JSON files to Postgres with the blueprint schema, plus workspaces, users and tracking lists.
- [ ] **Claude** · Shared collection cache: if several customers track the same creator, scrape once and serve everyone (each still pays their credits).
- [ ] **Claude** · Job system: daily scheduled runs per tracking list, a queue for on-demand reports, retries of failed items only, never re-scraping saved data.
- [ ] **Claude** · Incremental stories: new posts attach to existing stories; stable IDs, version history, dormant after quiet days.
- [ ] **Claude** · Global safety caps on Apify and Gemini spend per day, independent of customer credits; alert and stop when reached.
- [ ] **You** · Rotate the Apify token (it appeared in this session's log); new keys live only in Render's secret settings.

## 3. Credits and billing

- [ ] **Claude** · Price list that turns every action into credits (draft below). Customers are charged by the price list, not by raw cost, so prices stay stable.
- [ ] **Claude** · Metering: tag every Apify run and Gemini call with workspace and job, record real cost next to credits charged, and report margin per action.
- [ ] **Claude** · Credit ledger: append-only grants (plan renewal), purchases, debits per job, refunds and adjustments; balance per workspace.
- [ ] **Claude** · Estimates before spending: show the credit cost before an on-demand report or a new tracked creator; reserve credits, settle after the run.
- [ ] **Claude** · Out of credits: pause tracking (don't delete), warn at 20% and 5% left, resume on top-up.
- [ ] **Claude** · Payment interface with a fake provider for development: subscriptions, top-ups, webhooks into the ledger, failed payments.
- [ ] **Claude** · (when N2 is ready) Razorpay behind that interface: plan subscriptions, top-up payments, webhooks, GST invoices.
- [ ] **Claude** · Plan limits: max tracked creators and keywords, seats (agencies), report size.
- [ ] **You** · Approve the price list after 2 weeks of measured beta costs.

## 4. Product

- [ ] **Claude** · Sign-in (Google + email link), workspaces with invited teammates and roles (agency seats).
- [ ] **Claude** · Onboarding: pick a niche, add creators by URL or handle with validation, add brands and keywords, see the credit estimate.
- [ ] **Claude** · Your feed: stories from your own tracking list, in the refined layout (main character, per-platform lines, where audiences stand).
- [ ] **Claude** · Shared feed: curated AI & tech stories included in every plan.
- [ ] **Claude** · On-demand story report: topic, brand or launch + date range → cross-platform story with evidence; export to PDF and copy-with-citations for writers.
- [ ] **Claude** · Alerts (a tracked story crosses a heat threshold) and daily or weekly email digests.
- [ ] **Claude** · Review queue for beta: stories land as drafts; approve, merge or reject.
- [ ] **Claude** · Billing pages: plan, credit balance, usage by action, invoices, top-up.
- [ ] **Claude** · A story publishes only if every citation, quote and number passes the checks.

## 5. Render setup and operations

- [ ] **You** · Confirm the Render workspace and add a payment method.
- [ ] **Claude** · Web service (app and API), background worker (jobs), cron jobs (daily runs, digests), Postgres, Key Value (queue and rate limits), environment groups for secrets.
- [ ] **Claude** · Separate staging and production; Razorpay test mode on staging.
- [ ] **Claude** · Backups: nightly Postgres backup plus raw Apify data kept in storage.
- [ ] **Claude** · Monitoring: failed jobs, spend caps and payment webhooks alert by email.
- [ ] **Claude** · Runbook: add a creator for a customer, re-run a day, fix or unpublish a story, refund credits, rotate keys.

## 6. Legal and compliance (India, paid)

- [ ] **You** · Legal view on commercial use of scraped platform data (LinkedIn and Instagram are the sensitive ones) and Apify's terms.
- [ ] **You + Claude** · Terms of service, privacy policy (DPDP Act), refund and cancellation policy (Razorpay requires it), AI-generated content disclosure.
- [ ] **You + Claude** · Comment policy: short quotes only, always linked, commenter usernames hidden by default for customers, takedown contact.
- [ ] **You** · GST registration and invoice details; accountant sign-off on how credits and top-ups are taxed.

## 7. Launch path

1. **Internal:** 7 scheduled days on your own tracking list with no manual fixes; costs measured per action.
2. **Private beta:** 3–5 design partners (N6) with free credits for 2–4 weeks; weekly feedback; price list calibrated.
3. **Paid launch checklist:**
   - [ ] Razorpay live, GST invoices tested end to end
   - [ ] Credits charged match measured costs at the target margin
   - [ ] 2 consecutive weeks with no failed daily run
   - [ ] Every published story passes checks
   - [ ] Legal documents published
   - [ ] Alerts tested by forcing failures
   - [ ] Keys rotated; secrets only on Render

---

## Draft credit model (hypothesis to test in beta)

**Cost basis from the dry run, not quotes:**
- **Tracking:** about $0.05–0.08 of Apify + Gemini per tracked creator per day, with deeper comments.
- **On-demand reports:** about $0.50–1.50 per report, depending on posts and comments.

**Rule:** price each action so its measured cost is at most about 30% of the credits charged.

| Action | Draft credits |
|---|---|
| Track one creator (all their platforms), per day | 20 |
| Track one brand or keyword across platforms, per day | 40 |
| On-demand story report (one topic, up to 7 days, 6 platforms) | 300–800, quoted before running |
| Shared curated feed | Included |
| Alert sent | 2 |
| Daily digest email | 5 |

| Draft plan (INR per month) | Credits included | Roughly covers |
|---|---|---|
| Starter | 5,000 | 8 creators tracked daily, or 3 brands |
| Pro | 16,000 | 20 creators + a few reports + alerts |
| Agency | 45,000 + seats | 50+ creators across client workspaces |

Plan prices and top-up rates get set after the beta measures real usage. The credit
numbers above are starting points only.

---

## Rough monthly running cost (estimates, before customers)

For the internal phase (10 creators, 3 subreddits, daily, deeper comments):

| Item | Estimate |
|---|---|
| Apify | $25–35 |
| Gemini (paid tier) | $3–10 |
| Render: web service, worker, cron, Postgres, Key Value | roughly $30–60 depending on instance sizes |

Customer usage is paid for by credits on top of this base.
