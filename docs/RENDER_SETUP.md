# Render setup

How to stand up staging and production for Content-Story from `render.yaml`, fill in the
secrets, and run the first day by hand. Read alongside `docs/OPERATIONS.md` (monitoring, money,
backups) and `docs/RUNBOOK.md` (procedures).

Per environment you get: a web service, a background worker, four cron jobs and a Postgres
database, all in Singapore. Staging is `content-story-staging-*`; production is `content-story-*`.

Nothing deploys on push. Every service has `autoDeployTrigger: off`, so a deploy is always you
clicking **Manual Deploy**. Secrets never enter git: `render.yaml` lists only their names.

Services build from the repo root and run `cd app && ...`, not `rootDir: app`. Render hides
files outside a service's root directory, and `npm run migrate` needs `db/` next to `app/`.
The same applies in a service's **Shell**, which opens at the repo root: run `cd app` first.

## 1. Before you start

- A Render workspace with a payment method. The worker, the cron jobs and paid Postgres are not free.
- The GitHub repo connected to Render (Account settings > GitHub).
- The keys in section 3. You can apply the blueprint first and fill keys in afterwards. A service
  missing a required key fails when it first needs that key; `npm run check:env -- worker` tells
  you which key is missing.

## 2. Apply the blueprint

1. Push the branch that contains `render.yaml` to GitHub. The file must be at the repo root.
2. Render dashboard > **New** > **Blueprint** > pick the repo and branch > **Apply**.
3. Render lists every `sync: false` key from both environment groups and asks for values. Leave
   blank any you don't have yet and fill them in later under **Environment > Environment Groups**.
4. Render creates the two databases, then builds each service once as part of the apply. That
   first build is the one exception to manual deploys.
5. **Suspend the eight cron jobs** (each cron job's page > **Suspend**). The worker runs the same
   schedule itself; see section 7.

The blueprint creates its own services and databases. It doesn't touch the hand-made ones (the
`content-story` web service and the `content-story-dev` database). Once staging works:

- Either let `npm run migrate` build the schema in `content-story-staging-db` and load the dry-run
  week with `npm run import:dryrun` from your machine, which has `dryrun/data`, pointed at the new
  database's external URL. Or copy the old database:
  `pg_dump "<content-story-dev external URL>" | psql "<content-story-staging-db external URL>"`.
- Suspend, then delete, the old `content-story` web service, so you aren't paying twice and
  Clerk's allowed origins point at one host.

To keep an existing service name, rename the old service in the dashboard first. A blueprint
can't adopt a service it didn't create, and a name clash makes the apply fail.

## 3. Fill each environment group

Dashboard > **Environment** > **Environment Groups** > `content-story-secrets-staging`, then
`content-story-secrets-production`. Keys with a plain default in `render.yaml` are already
filled in. These are the ones you type:

| Key | Where it comes from |
|---|---|
| `ADMIN_EMAILS` | Your own email address(es), comma-separated. These users see `/admin` and get ops emails (failed runs, spend caps). Sign in once with the first address: ops emails are recorded against a workspace that address owns. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | [Clerk](https://dashboard.clerk.com) > your application > **API keys**. Use the *Development* instance for staging and the *Production* instance for production. In that Clerk instance, add the service's `APP_URL` as an allowed origin/domain. |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | [Razorpay dashboard](https://dashboard.razorpay.com) > **Account & Settings** > **API Keys**. Staging gets **Test mode** keys (`rzp_test_...`). Production gets **Live mode** keys, which exist only after KYC and the GSTIN (N1, N2). Turn on **Subscriptions** for the account. |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay > **Account & Settings** > **Webhooks** > add `<APP_URL>/api/webhooks/razorpay` for `subscription.*`, `order.paid` and `payment.failed`. The secret you type there is this value. It is not the API key secret. Make one webhook per mode: test for staging, live for production. |
| `APIFY_TOKEN` | [Apify console](https://console.apify.com) > **Settings** > **API & Integrations** > create a new personal API token. The dry-run token appeared in a log, so make fresh ones. A separate token per environment makes rotation easier. |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com) > **Get API key**. Create it in a Google Cloud project with **billing enabled** (N4). The free tier has low daily limits, and Google may use free-tier data, so it can't be used for customer data. |
| `RESEND_API_KEY`, `EMAIL_FROM` | [Resend](https://resend.com) > **Domains** > add your domain. Create the DNS records Resend shows (SPF TXT, DKIM, and the bounce MX) at your DNS provider and wait for **Verified**. Then **API Keys** > create a *sending access* key. `EMAIL_FROM` is an address on the verified domain, e.g. `Content-Story <stories@yourdomain.in>`. Until the key is set, emails are recorded and logged as `[email:fake]` but not sent. |
| `SUPPORT_EMAIL`, `SUPPORT_PHONE`, `BUSINESS_ADDRESS` | What `/contact` shows. Razorpay's live-mode review expects a reachable contact and a registered address on the site. |

The other keys have defaults in `render.yaml`: `APP_URL`, `PAYMENT_PROVIDER`, `PIPELINE_PROVIDER`,
the two daily caps, the Gemini models, `COMMENTS_PER_RUN`,
`STORY_DORMANT_DAYS`, `DATABASE_SSL`, `CREDIT_INR`, `USD_INR` and
`TOPUP_PAISE_PER_CREDIT`. `USD_INR` is the rupees-per-dollar rate that both the admin pages and
`npm run margin` use. `DATABASE_URL` isn't in the groups; each
service gets it from its database (`fromDatabase`).

`PIPELINE_PROVIDER=fake` and `DRYRUN_DATA` are for local development only. Fake mode replays
`dryrun/data`, which isn't in git and doesn't exist on Render.

After you change a group, **Manual Deploy** each service that should pick up the change.

To check that a service has what it needs, open its **Shell** tab:

```bash
cd app
npm run check:env -- web       # on the web service
npm run check:env -- worker    # on the worker
npm run check:env -- cron      # on a cron job
```

It prints set, MISSING or unset for each variable, never the values. It exits 1 if a required
variable is missing.

## 4. Postgres: move off the free plan before 13 Oct 2026

Render deletes a free Postgres instance about 30 days after it is created. The hand-made
`content-story-dev` expires on **13 Oct 2026**; `content-story-staging-db` shows its own date on
its page. Production must never be on the free plan, because backups and point-in-time recovery
exist only on paid plans.

To upgrade: database page > **Info** > **Update** instance type > pick `0.5c-1g` (the smallest
paid plan) or larger > save. Storage can grow later but never shrink. If the blueprint created
the database, also change its `plan:` in `render.yaml`, so the next blueprint sync doesn't try to
set it back.

## 5. Deploying

1. Push to the branch the blueprint tracks.
2. Dashboard > service > **Manual Deploy** > **Deploy latest commit** (or pick a commit).
3. Deploy the **web** service first. It starts with `npm run migrate && npm run start`, so
   migrations run before the new code serves. Then deploy the **worker**, which finishes its
   current job before stopping. Deploy the cron jobs too if they are in use; they only enqueue.
4. Watch **Logs** until the web service passes its health check on `/` and the worker logs
   `[worker] ready: working daily, report, alerts, digest, housekeeping; caps ...`.

To apply a `render.yaml` change (a new key, a plan change): **Blueprints** > your blueprint >
**Manual sync**.

## 6. First daily run by hand

Do this on staging first, then on production. Use the **worker** service's **Shell** (the web
service's shell works too; it has the same code and environment group).

```bash
cd app
npm run check:env -- worker     # everything required is set?
npm run daily -- --dry          # per workspace: targets, credits a day would charge, credits
                                # available, and whether some targets would pause.
                                # Charges nothing, collects nothing.
npm run daily                   # the real run, in this shell
```

`npm run daily` runs the same job the worker runs at 06:00 IST, in the foreground. It charges
each workspace's tracking for the day, then collects and processes. It adds a row to `runs`,
writes costs to `cost_events`, and shows up on **/admin/runs**. Re-running a date charges nothing
twice, and collection skips any source collected within the current collection interval (set at
**/admin/settings**).

To try a run with almost no spend, set `APIFY_DAILY_CAP_USD` and `GEMINI_DAILY_CAP_USD` low in
the staging group, redeploy the worker, and run it. Collection stops at the cap and you get the
ops email, which also tests alerting.

## 7. Schedules: worker vs cron jobs

There are two ways to trigger the same jobs.

**In-worker schedules (the default, always on).** When `npm run worker` starts, it registers its
timetable with pg-boss in IST: daily at 06:00, alerts every 30 minutes, digest at 08:00,
housekeeping hourly, and stuck reports re-queued every 5 minutes. No setting turns this off
today, and the worker always has to run, because it is the only process that does the work.

**Render cron jobs (backstop).** Each cron job runs
`cd app && npm run enqueue -- <daily|alerts|digest|housekeeping>`, which queues one job and exits.
The worker still does the work. The schedules match the worker's in UTC: `30 0 * * *` is
06:00 IST and `30 2 * * *` is 08:00 IST (N9).

- **Normal operation:** worker running, cron jobs **suspended**.
- **Worker scheduler suspect** (e.g. worker logs show no `daily job ... started` at 06:00):
  **Resume** the cron jobs. The queues are pg-boss *stately* queues, which drop a second copy of
  a job already queued, and the daily job is keyed by its IST date. Running both is safe, just
  redundant. Suspend the cron jobs again once the worker is fixed.
- **Queue one job now**, without a shell: the cron job's page > **Trigger Run**. That works even
  while the cron job is suspended. From a shell: `npm run enqueue -- daily --date 2026-09-16`.

A true cron-only setup, where the worker doesn't schedule, would need a small change to
`app/scripts/worker.js`: skip `registerSchedules` behind an environment flag.

## 8. Custom domain (later, N3)

Web service > **Settings** > **Custom Domains** > add the domain and create the DNS record it
shows. Then update `APP_URL` in the production group, the allowed origins in Clerk and the
webhook URL in Razorpay, and redeploy the web service and the worker.
