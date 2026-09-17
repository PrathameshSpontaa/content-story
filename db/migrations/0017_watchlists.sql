-- Watchlists: a workspace groups what it follows into watchlists (one per client, campaign or interest).
-- Each has its own follows and its own tags, the kinds of story it wants, and its stories are built into
-- its own 'following' feed. A follow can be in several watchlists and is collected and charged once.
-- The first watchlist of a workspace is made by the app (lib/watchlists.js), with the tags for its use case.
-- Every statement is idempotent so a re-run is a no-op.

create table if not exists watchlists (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces (id) on delete cascade,
  name          text not null,
  created_by    uuid references users (id) on delete set null,
  created_at    timestamptz not null default now()
);
create unique index if not exists watchlists_workspace_name on watchlists (workspace_id, lower(name));

create table if not exists watchlist_targets (
  watchlist_id  uuid not null references watchlists (id) on delete cascade,
  target_id     uuid not null references tracking_targets (id) on delete cascade,
  added_at      timestamptz not null default now(),
  primary key (watchlist_id, target_id)
);
create index if not exists watchlist_targets_target on watchlist_targets (target_id);

-- A kind of story a watchlist wants. `rule` is what the AI reads; `template` names the ready-made tag it
-- started from (null for one written from scratch). A new story needs `min_sources` sources, where 2 also
-- lets one post with a lift of 3 or more through.
create table if not exists watchlist_tags (
  id            uuid primary key default gen_random_uuid(),
  watchlist_id  uuid not null references watchlists (id) on delete cascade,
  name          text not null,
  rule          text not null,
  min_sources   integer not null default 1 check (min_sources in (1, 2)),
  template      text,
  position      integer not null default 0,
  created_at    timestamptz not null default now()
);
create unique index if not exists watchlist_tags_name on watchlist_tags (watchlist_id, lower(name));

-- A workspace now has one feed per watchlist; only its reports feed stays one of a kind. A deleted
-- watchlist's feed is archived, so stories saved from it stay readable.
alter table feeds add column if not exists watchlist_id uuid references watchlists (id) on delete set null;
create unique index if not exists feeds_watchlist on feeds (watchlist_id) where watchlist_id is not null;
drop index if exists feeds_workspace_kind;
create unique index if not exists feeds_workspace_reports on feeds (workspace_id) where kind = 'reports' and workspace_id is not null;
alter table feeds drop constraint if exists feeds_kind_check;
alter table feeds add constraint feeds_kind_check check (kind in ('shared', 'following', 'reports', 'archived'));
-- The tags and brands the last grouping was given: changing them groups the watchlist's posts again.
alter table feeds add column if not exists grouped_key text;

-- The tag a story was made for. `tag` keeps its name if the tag is later removed.
alter table stories add column if not exists tag_id uuid references watchlist_tags (id) on delete set null;
alter table stories add column if not exists tag text;

-- Posts are no longer kept out of stories for not being news: the card marks noise (a post with nothing to
-- say) and each watchlist's tags decide what becomes a story. Older cards keep their newsworthy answer.
alter table story_cards add column if not exists noise boolean;
alter table story_cards alter column newsworthy drop not null;
