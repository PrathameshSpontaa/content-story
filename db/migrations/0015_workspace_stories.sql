-- Stories are private to a workspace: each one gets a 'following' feed, built only from the creators,
-- subreddits and brands it follows, next to its 'reports' feed. The shared feed (no workspace) is
-- no longer built or shown to users; its old stories stay for the record.
-- Every statement is idempotent so a re-run is a no-op.
alter table feeds add column if not exists kind text not null default 'reports';
update feeds set kind = 'shared' where workspace_id is null and kind <> 'shared';
do $$ begin
  alter table feeds add constraint feeds_kind_check check (kind in ('shared', 'following', 'reports'));
exception when duplicate_object then null;
end $$;
create unique index if not exists feeds_workspace_kind on feeds (workspace_id, kind) where workspace_id is not null;

-- The last grouping that went through: when, and which posts it was given. A run whose posts are all
-- among those skips the grouping call instead of paying for the same answer again.
alter table feeds add column if not exists grouped_at timestamptz;
alter table feeds add column if not exists grouped_post_ids text[];
