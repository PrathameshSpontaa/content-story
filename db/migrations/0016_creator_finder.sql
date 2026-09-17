-- The channel finder: a name or one profile link in, every channel of that creator out, found with
-- AI web search. Answers are kept for a while so the same person or niche isn't paid for twice.
-- Every statement is idempotent so a re-run is a no-op.
create table if not exists creator_lookups (
  key         text primary key,                      -- 'find:x:@handle', 'find:name:ritu david', 'suggest:agency:indian marketing'
  result      jsonb not null,
  created_at  timestamptz not null default now()
);

-- When the finder last looked for a creator's other channels, so a creator added with one channel is
-- checked once, not on every page load.
alter table creators add column if not exists channels_checked_at timestamptz;
