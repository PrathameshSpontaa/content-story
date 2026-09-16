-- Referrals: every workspace can share a link; a friend who signs up through it starts with bonus
-- credits, and the referrer earns credits once that friend has set up their stories.
-- Every statement is idempotent so a re-run is a no-op.
alter table workspaces add column if not exists referral_code text;
create unique index if not exists workspaces_referral_code_key on workspaces (referral_code);

create table if not exists referrals (
  id                     uuid primary key default gen_random_uuid(),
  referrer_workspace_id  uuid not null references workspaces (id) on delete cascade,
  referred_workspace_id  uuid not null unique references workspaces (id) on delete cascade,  -- a workspace is referred at most once
  referred_user_id       uuid references users (id) on delete set null,
  code                   text not null,                                                      -- the code used, kept even if it changes later
  status                 text not null default 'joined' check (status in ('joined', 'rewarded', 'capped')),
  joined_at              timestamptz not null default now(),
  rewarded_at            timestamptz
);
create index if not exists referrals_referrer on referrals (referrer_workspace_id, joined_at desc);
