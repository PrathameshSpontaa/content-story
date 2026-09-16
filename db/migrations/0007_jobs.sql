-- Job system: what a run did and what it cost us, a note on each notification (the low-credits
-- threshold, the spend cap and day) so the same one is never written twice, and indexes for the
-- daily spend-cap check, the notifier's unsent queue and the run list. pg-boss keeps its own
-- 'pgboss' schema, created when the worker first starts.
alter table runs add column if not exists summary jsonb;
alter table runs add column if not exists usd numeric(12, 6);

alter table notifications add column if not exists note text;

create index if not exists cost_events_provider_created on cost_events (provider, created_at);
create index if not exists cost_events_run on cost_events (run_id) where run_id is not null;
create index if not exists notifications_unsent on notifications (created_at) where sent_at is null;
create index if not exists notifications_workspace_note on notifications (workspace_id, note) where note is not null;
create index if not exists runs_started on runs (started_at desc);
create index if not exists tracking_targets_paused on tracking_targets (workspace_id) where paused_reason = 'out_of_credits';
create index if not exists credit_entries_action_created on credit_entries (action, created_at) where kind = 'debit';
create index if not exists reports_queued on reports (updated_at) where status = 'queued';
