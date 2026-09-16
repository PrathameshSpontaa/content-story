-- Email notifications, digest settings and team invites. Additive and safe to run twice.

-- Ops emails go to an admin address and belong to no workspace.
alter table notifications alter column workspace_id drop not null;
alter table notifications add column if not exists provider_id text;   -- id the email provider returned
alter table notifications add column if not exists note text;          -- short message for low_credits and ops emails
alter table notifications add column if not exists subject text;

create index if not exists notifications_workspace_kind_story on notifications (workspace_id, kind, story_id);
create index if not exists notifications_pending on notifications (created_at) where sent_at is null and error is null;

-- One digest setting per workspace; last_sent_on is an IST date.
create table if not exists digest_settings (
  workspace_id  uuid primary key references workspaces (id) on delete cascade,
  frequency     text not null default 'off' check (frequency in ('off', 'daily', 'weekly')),
  destination   text not null,
  last_sent_on  date,
  updated_at    timestamptz not null default now()
);

create table if not exists invites (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces (id) on delete cascade,
  email         text not null,
  role          member_role not null default 'member',
  token         text not null unique,
  invited_by    uuid references users (id) on delete set null,
  expires_at    timestamptz not null,
  accepted_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists invites_workspace on invites (workspace_id, lower(email));
