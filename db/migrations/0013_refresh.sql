-- On-demand refreshes: one row per "refresh now" a workspace asks for (or, with no workspace, a full
-- collection run an admin started), so the app can show its state and enforce cooldowns and limits.
create table if not exists refresh_requests (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references workspaces (id) on delete cascade,   -- null: full scheduled run requested by an admin
  requested_by  uuid references users (id) on delete set null,
  reason        text not null,                                        -- 'button', 'follow', 'admin'
  status        text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'skipped')),
  run_id        uuid references runs (id) on delete set null,
  error         text,
  summary       jsonb,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);

create index if not exists refresh_requests_workspace_created on refresh_requests (workspace_id, created_at desc);
create index if not exists refresh_requests_open on refresh_requests (status) where status in ('queued', 'running');
