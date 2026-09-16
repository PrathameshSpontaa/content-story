# Operations

How to keep Content-Story running every day without surprises on the bill. Procedures are in
`docs/RUNBOOK.md`; Render setup is in `docs/RENDER_SETUP.md`. Shell commands run in a Render
service's **Shell** after `cd app`.

## Daily rhythm (IST)

The worker (`npm run worker`) keeps this timetable. The cron jobs are a suspended backstop.

| When | Job | What it does |
|---|---|---|
| 06:00 | `daily` | Charges each workspace's active tracking for the day (pausing targets it can't pay for), then collects from Apify and runs the pipeline |
| every 30 min | `alerts` | Emails stories that crossed a workspace's heat threshold |
| 08:00 | `digest` | Sends daily digests, and weekly ones on their day |
| hourly | `housekeeping` | Releases expired credit holds, resumes targets paused for `out_of_credits` once the workspace can pay, sends unsent emails (including ops emails) |
| every 5 min | `housekeeping` (stuck reports) | Re-queues on-demand reports stuck in `queued` |

## Money: the daily caps

Customers pay in credits by the price list. Our real costs are Apify and Gemini, recorded per
call in `cost_events`. Two global caps (`app/lib/spend.js`) protect against a runaway day,
whatever customers' credits say:

- `APIFY_DAILY_CAP_USD` (code default 10): before every Apify actor run, the pipeline sums
  today's Apify `cost_events` since midnight IST. Once the sum reaches the cap, the run is
  refused. Each actor run also has its own hard charge limit on Apify's side.
- `GEMINI_DAILY_CAP_USD` (code default 5): the same check before every Gemini call.

When a cap is hit, the job throws `SpendCapReached`. The run ends `failed`, with the cap message
in `runs.error`. One ops notification is written per provider per day, with the note
`spend_cap:<provider>:<date>: the $<cap> daily cap is reached; collection stops until tomorrow`.
The next day starts fresh. Customers aren't charged twice when the day is re-run, and sources
skipped today are collected on the next run. What to do is in the runbook (procedure 8).

`render.yaml` sets $3 Apify / $2 Gemini on staging and $10 / $5 on production. The dry run
measured roughly $0.05-0.08 of Apify plus Gemini per tracked creator per day, so those numbers
leave plenty of headroom for the internal phase. Raise them as customers arrive.
`npm run margin -- --days 14` shows credits charged against real cost per action, plus provider
cost per day.

Also cap at the source, in case the worker itself misbehaves: Apify console > **Settings** >
**Usage limits** (monthly), and Google Cloud > **Billing** > **Budgets & alerts** on the Gemini
project.

## Referrals

Every workspace has a link, `/r/CODE`, shown on the Refer page. Opening it sets a 30-day cookie
and goes to sign-up; when that browser's account is created, the new workspace is recorded in
`referrals` and gets its welcome bonus at once. The referrer is paid when the friend finishes or
skips first-run setup (`status` goes `joined` → `rewarded`) and gets an email. Rewards stop after
`REFERRAL.maxRewarded` friends per workspace (`status = 'capped'`); friends still get their bonus.
Amounts live in `app/lib/pricing.js` (`REFERRAL`). Both grants are `credit_entries` rows with
`reference = 'referral'` and keys `referral:<id>:friend` / `referral:<id>:referrer`, so nothing
can be paid twice. Suspect abuse? `select referrer_workspace_id, count(*) from referrals group by 1
order by 2 desc` shows who is bringing in accounts; delete the `referrals` row and add an
`adjustment` entry to claw credits back. `npm run test:referrals` checks the whole flow.

## Where failed runs show up

1. **/admin/runs** ("Runs and spend", for `ADMIN_EMAILS` users): every run with kind, status
   (`running`, `done`, `failed`), cost and error. It also shows today's spend against the caps,
   margin per action, and the last 20 emails that failed or haven't gone out.
2. **Ops emails** to the first address in `ADMIN_EMAILS`: a failed daily run, a failed report, a
   spend cap. The subject is `Content-Story ops: <first line of the note>`. They are written to
   `notifications` (kind `ops`) and sent by the hourly housekeeping job, so allow up to an hour.
   The row is recorded against a workspace that address *owns*. If that admin has never signed
   in, nothing is written: sign in once after setting `ADMIN_EMAILS`.
3. **Worker logs** (service > **Logs**). Lines are prefixed `[worker]`, `[boss]`, `[daily]`, or
   `[<queue> <job id>]` for a job in progress, e.g. `[daily 3f2a9c1b] failed: ...`.
4. **`webhook_events`**: every Razorpay webhook, with `processed_at` and `error`. A row with an
   `error` and no `processed_at` is a payment that hasn't been credited yet. Razorpay retries it.

While `RESEND_API_KEY` is unset, emails, including ops emails, only appear in the logs as
`[email:fake] to ... · subject`. Set the key before you rely on email alerts.

## Render's own alerts

Dashboard > **Account settings** > **Notifications**, and per service under **Settings** >
**Notifications**. For production at least, turn on:

- **Deploy failed**: a Manual Deploy didn't build or didn't pass the health check on `/`.
- **Service failure / unhealthy**: the web service stops answering, or the worker process keeps
  exiting (Render restarts it; a crash loop needs a look).
- **Cron job failed**: while cron jobs are in use, an `enqueue` run exited non-zero, which
  almost always means the database was unreachable.
- Postgres storage and CPU for `content-story-db` (database page > **Metrics**/alerts), so you
  hear about a filling disk before the daily run does.

Send them to the `ADMIN_EMAILS` address. Slack comes later (N11).

## Backups

There are two layers, because raw Apify payloads are the one thing that can't be recreated
without paying again.

**Render Postgres (production, paid plan).** Paid plans get automatic daily backups and
point-in-time recovery; there is nothing to configure. Free instances get none, which is why
production is on `0.5c-1g` and staging data is disposable. For a copy in your own hands: database
page > **Recovery**/**Backups** > export, or run
`pg_dump "<external connection string>" -Fc -f content-story-YYYY-MM-DD.dump` from a machine on
the database's IP allow list.

**Raw captures (weekly).** `app/scripts/export-raw.js` writes `raw_captures` rows older than N
days, with their Apify `payload`, plus `cost_events` rows, to gzip JSON-lines files named by
date: `raw-captures-YYYY-MM-DD.jsonl.gz` and `cost-events-YYYY-MM-DD.jsonl.gz`. With `--delete`
it nulls the archived payloads and sets `storage_path` to `archive:<file>`. Posts, comments and
stories stay. Run it weekly:

```bash
cd app
RAW_ARCHIVE_DIR=/tmp/archive node scripts/export-raw.js 30            # export only; check the files
RAW_ARCHIVE_DIR=/tmp/archive node scripts/export-raw.js 30 --delete   # export again, then trim
```

A Render service's disk isn't persistent, so copy the files somewhere you keep backups (a bucket,
Google Drive, a NAS) before the shell closes. Easier still, run it from your own machine with
`DATABASE_URL` set to the external connection string and `RAW_ARCHIVE_DIR` pointing at a local
folder. `--delete` refuses to run unless `RAW_ARCHIVE_DIR` is set explicitly. `cost_events` are
archived but never deleted.

Restores are in the runbook (procedure 9).

## Launch checklist (LAUNCH_PLAN.md section 7): how to verify each item

**Razorpay live, GST invoices tested end to end.** On production with live keys, buy the
smallest top-up with a real UPI payment. Confirm: `payments.status = 'captured'`, one
`credit_entries` row of kind `purchase`, the `webhook_events` row with `processed_at` set, and
the invoice on `/billing` with CGST+SGST or IGST correct for the workspace's `billing_state`.
Resend the same webhook from Razorpay > Webhooks and confirm the balance doesn't change. Refund
the payment in Razorpay.

**Credits charged match measured costs at the target margin.** Run `npm run margin -- --days 14`
on the worker, or read the margin table on /admin/runs. Each action's margin should be at the
target from the credit model in `LAUNCH_PLAN.md`. If not, change `price_list` and measure
another week.

**2 consecutive weeks with no failed daily run.** /admin/runs shows every `daily` run of the
last 14 days as `done`. Or, in psql:
`select (started_at at time zone 'Asia/Kolkata')::date as day, status from runs where kind = 'daily' and started_at > now() - interval '14 days' order by 1;`
You need one `done` row per day, no `failed` rows, and no missing days.

**Every published story passes checks.** Publishing (the admin review page, or auto-publish)
refuses a story with no version that passed. Stories are shown from their latest passing version.
This should return 0:
`select count(*) from stories s where s.published_at is not null and not exists (select 1 from story_versions v where v.story_id = s.id and v.passed);`

**Legal documents published.** `/terms`, `/privacy`, `/refunds` and `/contact` show the reviewed
text, not the drafts, and `/contact` shows `SUPPORT_EMAIL`, `SUPPORT_PHONE` and
`BUSINESS_ADDRESS`. Razorpay's live review looks for all four.

**Alerts tested by forcing failures.** On staging:
1. Set `APIFY_DAILY_CAP_USD` to `0`, redeploy the worker, run `npm run daily`. Expect a failed
   run on /admin/runs and a `spend_cap:apify:...` ops email within the hour.
2. Set `GEMINI_API_KEY` to a wrong value and run again. Expect a failed run and an ops email.
3. Set `RESEND_API_KEY` to a wrong value and wait for the next housekeeping run. Expect
   `notifications.error` set, and the email listed under "Emails not sent" on /admin/runs.
4. Suspend the worker for a day. Expect Render's service alert, and no `daily` run on
   /admin/runs.

Restore the real values and redeploy afterwards.

**Keys rotated; secrets only on Render.** Every key in the production group was created after the
dry run, and the dry-run Apify token is revoked. `git log -p -S rzp_ ` and a search of the repo
for key prefixes (`rzp_`, `sk_live_`, `re_`, `apify_api_`, `AIza`) find nothing. `.env.local`
files exist only on your machine.
