-- Incremental stories: the review fields and merge candidates the story builder writes (the same
-- definitions as 0009_admin.sql, so whichever runs first wins), plus indexes for its lookups.
-- Additive and idempotent: safe on the live database.
alter table stories add column if not exists review_note text;
alter table stories add column if not exists reviewed_at timestamptz;
alter table stories add column if not exists reviewed_by uuid;

-- Two stories the pipeline thinks may be the same; a reviewer merges them or keeps them apart.
-- The pipeline stores each pair once, with the smaller uuid as story_a.
create table if not exists merge_candidates (
  story_a      uuid not null references stories (id) on delete cascade,
  story_b      uuid not null references stories (id) on delete cascade,
  reason       text,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  primary key (story_a, story_b)
);
create index if not exists merge_candidates_story_b on merge_candidates (story_b);

-- Which story a post is already in (the builder's window skips those posts).
create index if not exists story_posts_post on story_posts (post_id);
-- Stories in a feed that share a main entity (the split-story check).
create index if not exists stories_feed_entity on stories (feed_id, main_entity_id);
