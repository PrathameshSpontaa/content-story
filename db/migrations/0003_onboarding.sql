-- Onboarding: when a workspace finished (or skipped) first-run setup, and what it's for.
alter table workspaces
  add column onboarded_at timestamptz,
  add column use_case text check (use_case in ('brand', 'agency', 'media', 'exploring'));

-- Starter matches the free trial's watchlist size; bigger plans get more room.
update plans set max_tracked_creators = 10, max_tracked_keywords = 3 where id = 'starter';
update plans set max_tracked_creators = 30, max_tracked_keywords = 10 where id = 'pro';
update plans set max_tracked_creators = 100, max_tracked_keywords = 40 where id = 'agency';
