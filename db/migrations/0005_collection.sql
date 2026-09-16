-- Daily collection: raw Apify items kept in the database until object storage exists, which
-- search query found a post, and when each brand or keyword was last searched per platform
-- (the shared collection cache for keywords, the way creator_handles.last_collected_at is for creators).
-- Additive and idempotent: safe on the live database.

alter table raw_captures add column if not exists payload jsonb;
create index if not exists raw_captures_run on raw_captures (run_id);
create index if not exists cost_events_run on cost_events (run_id);

-- A post found by search-based collection, with the query that found it. workspace_id is null
-- for keyword tracking targets (shared collection) and set for on-demand reports.
create table if not exists post_queries (
  id            bigint generated always as identity primary key,
  post_id       text not null references posts (id) on delete cascade,
  query         text not null,
  workspace_id  uuid references workspaces (id) on delete cascade,
  found_at      timestamptz not null default now()
);
create unique index if not exists post_queries_key
  on post_queries (post_id, lower(query), coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists post_queries_query on post_queries (lower(query), found_at desc);

-- When a keyword was last searched on a platform; every workspace tracking it shares the result.
create table if not exists query_collections (
  query_key          text not null,          -- lower-cased, whitespace-collapsed query
  platform           platform not null,
  last_collected_at  timestamptz not null default now(),
  primary key (query_key, platform)
);
