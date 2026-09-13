-- Product layer: accounts linked to Clerk, saved stories, community tracking price,
-- draft plans, one watchlist entry per thing tracked, and report fulfilment fields.

alter table users add column clerk_user_id text unique;

create table saved_stories (
  workspace_id  uuid not null references workspaces (id) on delete cascade,
  story_id      uuid not null references stories (id) on delete cascade,
  saved_by      uuid references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  primary key (workspace_id, story_id)
);

insert into price_list (action, credits, unit) values
  ('track_community_day', 20, 'per tracked community per day')
on conflict (action) do nothing;

-- Draft prices (before GST) until the beta measures real usage; edit rows here, not in code.
insert into plans (id, name, price_paise, credits_per_period, max_tracked_creators, max_tracked_keywords, max_seats) values
  ('starter', 'Starter', 499900, 5000, 8, 3, 1),
  ('pro', 'Pro', 1499900, 16000, 20, 8, 3),
  ('agency', 'Agency', 3999900, 45000, 60, 25, 10)
on conflict (id) do nothing;

-- A workspace tracks each creator, keyword or community once.
create unique index tracking_targets_creator on tracking_targets (workspace_id, creator_id) where kind = 'creator';
create unique index tracking_targets_query on tracking_targets (workspace_id, kind, lower(query)) where kind <> 'creator';

alter table reports
  add column note text,
  add column updated_at timestamptz not null default now(),
  add constraint reports_status check (status in ('queued', 'in_progress', 'ready', 'failed', 'cancelled'));

-- Re-importing the shared feed replaces its stories; a finished report keeps its row.
alter table reports drop constraint reports_story_id_fkey;
alter table reports add constraint reports_story_id_fkey foreign key (story_id) references stories (id) on delete set null;
