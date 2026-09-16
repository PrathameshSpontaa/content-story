-- Who made the last review decision on a story: the AI editor or a person in the admin panel.
-- A person's decision is final; the AI never overrides it. story_versions.editor keeps the AI
-- editor's verdict for that version (decision, reason, confidence, model).
alter table stories add column if not exists review_source text check (review_source in ('ai', 'human'));
alter table story_versions add column if not exists editor jsonb;
alter table merge_candidates add column if not exists decision jsonb;
