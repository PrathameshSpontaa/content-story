-- Review queue and operations dashboard. Every statement is idempotent: the pipeline, merge and
-- notification migrations (0005 to 0008) add the same columns with the same definitions, so
-- whichever runs first wins and the other is a no-op.
alter table stories add column if not exists review_note text;
alter table stories add column if not exists reviewed_at timestamptz;
alter table stories add column if not exists reviewed_by uuid;

-- Two stories the pipeline thinks may be the same; a reviewer merges them or keeps them apart.
create table if not exists merge_candidates (
  story_a      uuid not null references stories (id) on delete cascade,
  story_b      uuid not null references stories (id) on delete cascade,
  reason       text,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  primary key (story_a, story_b)
);

alter table runs add column if not exists summary jsonb;
alter table runs add column if not exists usd numeric;

alter table notifications add column if not exists subject text;
alter table notifications add column if not exists note text;
