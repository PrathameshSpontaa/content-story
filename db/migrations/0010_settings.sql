-- Operator settings the admin panel changes without a deploy: how often collection runs, whether the
-- AI publishes and merges stories on its own, and the limits on on-demand refreshes.
create table if not exists app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references users (id) on delete set null
);
