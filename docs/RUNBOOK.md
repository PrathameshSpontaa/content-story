# Runbook

Procedures for running Content-Story day to day.

- *shell*: a Render service's **Shell** tab (use the worker; the web service works too). The shell
  opens at the repo root, so start with `cd app`. Every command below assumes you are in `app/`.
- *psql*: the environment's database. Database page > **Connect** > copy the **External**
  connection string, add your IP to the allow list, then `psql "<string>"`.
- *admin*: the site's `/admin` pages, signed in with an address in `ADMIN_EMAILS`.

When in doubt, do it on staging first. Production's database has point-in-time recovery;
staging's free one has none.

## 1. Add a creator for a customer

Customers can do this themselves: **Following** > add by link or handle. To do it for them:

1. Find the workspace id (*psql*):
   ```sql
   select w.id, w.name, u.email from workspaces w
     join memberships m on m.workspace_id = w.id join users u on u.id = m.user_id
    where lower(u.email) = lower('<customer email>');
   ```
2. Look the profile up (*shell*):
   ```bash
   node --input-type=module -e "const m = await import('./lib/watchlist.js'); console.log(await m.lookupProfile('<workspace id>', '<profile url>')); process.exit(0)"
   ```
   - `status: 'existing'`: we already cover the creator. Follow it:
     ```bash
     node --input-type=module -e "const m = await import('./lib/watchlist.js'); console.log(await m.followCreator('<workspace id>', '<creator.id from step 2>')); process.exit(0)"
     ```
   - `status: 'new'`: create and follow in one step. Add one `{ platform, input }` per platform
     the creator posts on (platforms: `x`, `youtube`, `linkedin`, `instagram`, `tiktok`):
     ```bash
     node --input-type=module -e "const m = await import('./lib/watchlist.js'); console.log(await m.createCreator('<workspace id>', { name: '<Creator name>', profiles: [{ platform: 'youtube', input: '<profile url>' }], follow: true })); process.exit(0)"
     ```
   - `status: 'community'`: it's a subreddit. The customer adds it under Subreddits.
   - A `LimitError` means the plan is full (trial: 10 creators or subreddits, 3 brands). An
     `ExistingCreatorError` means one of the profiles already belongs to someone else.
3. The creator is charged and collected on the next daily run (06:00 IST). To start now:
   `npm run daily` (*shell*). A same-day re-run doesn't charge anyone twice.
4. Confirm on the customer's **Following** page, or with
   `select kind, creator_id, query, active, paused_reason from tracking_targets where workspace_id = '<workspace id>';` (*psql*).

## 2. Re-run a day

A re-run is safe. The day's tracking charge is idempotent per date, and collection skips any
source collected within most of the collection interval set at **/admin/settings** (23.5 hours
when collection runs once a day). Set `COLLECT_MIN_HOURS` in the shell only to override that for
one manual run.

1. See what happened: *admin* **/admin/runs** (status and error of each run), or the worker logs
   filtered by `daily`.
2. Preview, then run today inline (*shell*):
   ```bash
   npm run daily -- --dry
   npm run daily
   ```
3. Re-run a specific IST date:
   ```bash
   npm run daily -- --date 2026-09-14
   ```
   Or queue it for the worker instead of running it in the shell:
   `npm run enqueue -- daily --date 2026-09-14`.
4. To force re-collection of one source inside that window, clear its
   timestamp first (*psql*), then run step 2:
   ```sql
   update creator_handles set last_collected_at = null where creator_id = '<creator id>';
   delete from query_collections where query_key = '<lower-cased, single-spaced keyword>';
   ```
5. A run stuck at `running` for hours, with no worker log activity, means the process died
   mid-run. Mark it failed and re-run (*psql*):
   `update runs set status = 'failed', finished_at = now(), error = 'marked failed by hand' where id = '<run id>';`

## 3. Fix or unpublish a story

The AI editor publishes, holds or rejects each new story that passes its checks, and merges
stories it judges to be the same. Both are switched at **/admin/settings**. With them off, new
stories and duplicate pairs wait for you. A decision you make here is final: the AI never
overrides a story you approved, unpublished, rejected or merged.

1. *admin* **/admin** > the review queue. Filter by Needs you, Published by AI, Published by you,
   Rejected, Merged or Unsure merges, then
   open a story: **/admin/stories/<id>** shows its latest version, checks, version history,
   posts and merge candidates.
2. **Unpublish**: click **Unpublish** and add a note if you like. The story leaves every feed,
   digest and alert immediately and stays in the database.
3. **Reject** (keep it out for good): **Reject** with a note ("Shown here only"). A rejected story
   can still be published later with **Approve and publish**, which puts it back to active.
4. **Approve**: **Approve and publish** works only when at least one version passed every check,
   and never for a merged story. Otherwise the page says why.
5. **Fix the content**: the pipeline writes a new version when new posts attach to the story. If a
   story is wrong because of its sources (a bad alias, a misattributed post), unpublish it, fix
   the source data, and re-run the day (procedure 2). Publish again once a passing version appears
   in the version history.

The **Needs you** filter lists what the AI held and the merges it was not sure about.

## 4. Merge two stories

1. *admin* **/admin/stories/<id>** for either story. Under merge candidates, the pipeline lists
   stories it thinks are the same (shared main entity, overlapping dates), each with three
   buttons:
   - **Merge this into it** (this story folds into the listed one) or **Merge it into this**
     (the listed one folds into this story): posts move to the target
     (duplicates skipped), the merged story leaves the feed with status `merged`, and anything
     that pointed at it now points at the target.
   - **Keep separate**: the pair stops being flagged.
   Keep the story with more sources as the target. Merging needs both stories in the same feed,
   and the target can't be merged or rejected.
2. If the pair wasn't flagged, merge from the shell. The first id is merged *into* the second:
   ```bash
   node --input-type=module -e "const m = await import('./lib/admin.js'); await m.mergeStory('<story to fold in>', '<target story>', { note: 'merged by hand' }); console.log('merged'); process.exit(0)"
   ```
3. Open the target's review page, check the combined posts, and publish when a passing version
   covers them (re-run the day if it needs rewriting).

## 5. Refund credits

The credit ledger is append-only: a refund is a new entry, never an edit.

1. *admin* **/admin** > the workspace list > the inline **Add** credits form: amount and a note
   saying why (e.g. `refund: report failed`). This adds a `grant` entry with reference
   `admin:<your email>`. A double submit grants only once.
2. For an entry that shows as a *refund* on the customer's ledger, use the shell instead (*shell*):
   ```bash
   node --input-type=module -e "const m = await import('./lib/credits.js'); console.log(await m.addCredits('<workspace id>', 250, { kind: 'refund', reference: 'admin:<your email>', idempotencyKey: 'refund:<ticket or date>:<workspace id>', note: '<why>' })); process.exit(0)"
   ```
   The `idempotencyKey` must be unique. Re-running with the same key does nothing.
3. Money refunds happen in Razorpay (**Transactions** > **Payments** > the payment > **Refund**).
   The app doesn't take credits back on a refund, so remove them yourself (*psql*):
   ```sql
   insert into credit_entries (workspace_id, kind, amount, reference, idempotency_key, note)
   values ('<workspace id>', 'adjustment', -<credits>, 'razorpay:<payment id>', 'refund-adjust:<payment id>', 'money refunded');
   ```
4. Check the balance on the customer's `/billing`, or with
   `select * from credit_balances where workspace_id = '<workspace id>';`.

## 6. Rotate keys

For each key: create the new one, put it in the environment group, **Manual Deploy** the listed
services, confirm, then revoke the old one. Staging and production have separate groups
(`content-story-secrets-staging`, `content-story-secrets-production`), so do each on its own.

| Key | Where to make the new one | Group key | Redeploy | Confirm (*shell*) |
|---|---|---|---|---|
| Apify | Apify console > Settings > API & Integrations > create token; delete the old one after | `APIFY_TOKEN` | worker | `node --input-type=module -e "const m = await import('./pipeline/apify.js'); console.log(await m.whoAmI())"` |
| Gemini | Google AI Studio > API keys > create in the paid project; delete the old key in AI Studio (or Google Cloud > APIs & Services > Credentials) | `GEMINI_API_KEY` | worker | next run on /admin/runs has no Gemini error, or `npm run daily` on staging |
| Resend | Resend > API Keys > create (sending access); delete the old one | `RESEND_API_KEY` (and `EMAIL_FROM` if the domain changed) | worker, web | the next housekeeping run sends waiting emails; nothing new under "Emails not sent" on /admin/runs |
| Clerk | Clerk > API keys > add a new secret key, deploy, then delete the old one | `CLERK_SECRET_KEY` (and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` if you changed instance) | web | sign out and in again |
| Razorpay API | Razorpay > Account & Settings > API Keys > **Regenerate**. The old pair stops working immediately, so update the group and deploy right away | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | web | a test-mode top-up on staging |
| Razorpay webhook | Razorpay > Account & Settings > Webhooks > edit the webhook > new secret | `RAZORPAY_WEBHOOK_SECRET` | web | resend a recent event from Razorpay; its `webhook_events` row has no `error` |

`DATABASE_URL` comes from the database (`fromDatabase`), not the group. If the database password
ever needs changing, change it on the database page, then redeploy the web service, the worker
and any cron jobs in use.

Rotate everything before the paid launch (checklist in LAUNCH_PLAN.md section 7), and whenever a
key has appeared in a log, a screenshot or a chat.

## 7. Pause a workspace

Pausing stops a workspace's daily charges and collection without deleting anything.

1. Workspace id: procedure 1, step 1.
2. Pause (*psql*):
   ```sql
   update tracking_targets set active = false, paused_reason = 'paused_by_admin'
    where workspace_id = '<workspace id>' and active;
   update alert_rules set active = false where workspace_id = '<workspace id>';
   update digest_settings set frequency = 'off', updated_at = now() where workspace_id = '<workspace id>';
   ```
   The daily run charges and collects only active targets. Housekeeping resumes targets paused
   for `out_of_credits` only, so `paused_by_admin` stays paused.
3. Resume. Note the digest frequency before pausing, so you can set it back:
   ```sql
   update tracking_targets set active = true, paused_reason = null
    where workspace_id = '<workspace id>' and paused_reason = 'paused_by_admin';
   update alert_rules set active = true where workspace_id = '<workspace id>';
   update digest_settings set frequency = '<daily|weekly>', updated_at = now() where workspace_id = '<workspace id>';
   ```
4. To also block sign-in, ban the users in Clerk (Users > user > **Ban user**). Undo with **Unban**.

## 8. A spend cap was hit

You get an ops email with a `spend_cap:<provider>:<date>` note, and the run is `failed` on
/admin/runs with "daily spend cap ... is reached" in its error.

1. Find what spent the money (*psql*):
   ```sql
   select provider, detail, workspace_id, count(*), round(sum(usd)::numeric, 3) as usd
     from cost_events
    where created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'
    group by 1, 2, 3 order by usd desc;
   ```
2. If one actor, model or workspace is far out of proportion, pause that target instead of
   raising the cap:
   `update tracking_targets set active = false, paused_reason = 'runaway_cost' where id = '<target id>';`
3. If the day was simply bigger (new customers, a busy news day), raise `APIFY_DAILY_CAP_USD` or
   `GEMINI_DAILY_CAP_USD` in the environment group, **Manual Deploy** the worker, then
   `npm run daily`. Sources already collected today are skipped, and nobody is charged twice.
4. Check that Apify's **Usage** page and Google Cloud billing agree with `cost_events`. Apify spend
   we didn't record means something outside the pipeline used the token, so rotate `APIFY_TOKEN`
   (procedure 6).
5. If the new cap is permanent, change it in `render.yaml` too, so a blueprint sync doesn't put
   the old value back.

## 9. Restore from a backup

**Production database (Render point-in-time recovery).**

1. Database page > **Recovery** > pick a time just before the damage > restore. Render creates a
   *new* database instance and leaves the current one alone.
2. Point the services at it. Either rename the instances in the dashboard (current one to
   `content-story-db-old`, restored one to `content-story-db`) and run a blueprint **Manual
   sync**, so `fromDatabase` picks up the restored instance. Or set `DATABASE_URL` by hand on the
   web service, the worker and the cron jobs in use (service > **Environment**) to the restored
   instance's internal URL.
3. **Manual Deploy** the web service (`npm run migrate` is a no-op when the schema is current),
   then the worker.
4. Check that `/admin` loads, that /admin/runs shows history up to the restore point, and that
   `select max(started_at) from runs;` looks right (*psql*).
5. Once you're sure, delete the old instance, and make `render.yaml` match.

**From a `pg_dump` file** (staging, or a copy you downloaded):
```bash
pg_restore --clean --if-exists --no-owner -d "<external connection string>" content-story-YYYY-MM-DD.dump
```
Then deploy the web service to run migrations.

**Raw capture archives** (files from `scripts/export-raw.js`). The app doesn't need them: posts,
comments and stories stay in the database. To put one capture's payload back for re-parsing or
evidence, run this from `app/` with `DATABASE_URL` set:
```bash
gzip -dc raw-captures-2026-09-16.jsonl.gz | grep '"id":"<capture id>"' > one.json
node --input-type=module -e "
  const { readFileSync } = await import('node:fs');
  const { pool } = await import('./lib/db.js');
  const row = JSON.parse(readFileSync('one.json', 'utf8'));
  await pool.query('update raw_captures set payload = \$1, storage_path = \$2 where id = \$3', [JSON.stringify(row.payload), 'db:' + row.id, row.id]);
  await pool.end();
  console.log('restored', row.id);
"
```

## 10. The worker isn't running jobs

1. Worker service > **Logs**. The same startup error over and over usually means a missing
   variable: `npm run check:env -- worker` (*shell*) names it. A healthy start logs
   `[worker] ready: working daily, report, alerts, digest, housekeeping; ...` and one
   `schedule <queue>/<key>` line per schedule.
2. pg-boss keeps its state in the `pgboss` schema of the same database. Queue state (*psql*):
   `select name, state, count(*) from pgboss.job group by 1, 2 order by 1, 2;`
   Many `retry` or `failed` jobs under one name point to that job, not the worker.
3. Restart: worker > **Manual Deploy** > **Restart service** (no rebuild).
4. While you investigate, **Resume** the cron jobs (`docs/RENDER_SETUP.md` section 7), or queue
   the day by hand with **Trigger Run** on the daily cron job. Duplicate jobs are dropped while
   one is already queued.
