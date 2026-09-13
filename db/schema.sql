-- Content-Story database schema, first draft for review (Postgres 16+).
-- Becomes the first migration once the app project exists.
--
-- Conventions
--   Money charged to customers: INR in paise (bigint), GST stored separately.
--   Our provider costs: USD, numeric(12, 6).
--   Collected content is shared: a creator tracked by five workspaces is scraped once.
--   AI output rows record the model and prompt version that produced them.
--   Story pages are stored as versioned JSON documents, the same shape the dry run proved.

-- ─── Accounts and workspaces ────────────────────────────────────────────────

create table users (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  name        text,
  created_at  timestamptz not null default now()
);
create unique index users_email_key on users (lower(email));

create table workspaces (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  gstin          text,            -- customer GSTIN for B2B invoices, optional
  billing_state  text,            -- Indian state code: decides CGST+SGST or IGST
  created_at     timestamptz not null default now()
);

create type member_role as enum ('owner', 'admin', 'member');

create table memberships (
  workspace_id  uuid not null references workspaces (id) on delete cascade,
  user_id       uuid not null references users (id) on delete cascade,
  role          member_role not null default 'member',
  primary key (workspace_id, user_id)
);

-- ─── Plans, subscriptions and payments ─────────────────────────────────────

create table plans (
  id                    text primary key,       -- 'starter', 'pro', 'agency'
  name                  text not null,
  price_paise           bigint not null,        -- monthly, before GST
  credits_per_period    integer not null,
  max_tracked_creators  integer not null,
  max_tracked_keywords  integer not null,
  max_seats             integer not null,
  provider_plan_ids     jsonb not null default '{}',  -- {"razorpay": "plan_..."} created on first use
  active                boolean not null default true
);

-- 'fake' is the development provider; 'razorpay' plugs in behind the same interface.
create type payment_provider as enum ('fake', 'razorpay');
create type subscription_status as enum ('pending', 'active', 'past_due', 'cancelled', 'expired');

create table subscriptions (
  id                        uuid primary key default gen_random_uuid(),
  workspace_id              uuid not null references workspaces (id) on delete cascade,
  plan_id                   text not null references plans (id),
  provider                  payment_provider not null,
  provider_subscription_id  text,
  status                    subscription_status not null default 'pending',
  current_period_start      timestamptz,
  current_period_end        timestamptz,
  created_at                timestamptz not null default now(),
  unique (provider, provider_subscription_id)
);

create type payment_kind as enum ('subscription', 'topup');
create type payment_status as enum ('created', 'captured', 'failed', 'refunded');

create table payments (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references workspaces (id) on delete cascade,
  subscription_id      uuid references subscriptions (id),
  provider             payment_provider not null,
  provider_payment_id  text,
  provider_order_id    text,
  kind                 payment_kind not null,
  status               payment_status not null default 'created',
  amount_paise         bigint not null,          -- total charged, GST included
  tax_paise            bigint not null default 0,
  credits              integer not null,         -- granted when the payment is captured
  invoice_number       text unique,
  created_at           timestamptz not null default now(),
  unique (provider, provider_payment_id)
);

-- A webhook delivered twice is recorded once and processed once.
create table webhook_events (
  provider      payment_provider not null,
  event_id      text not null,
  type          text not null,
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  error         text,
  primary key (provider, event_id)
);

-- ─── Credits ────────────────────────────────────────────────────────────────

-- What each action costs in credits. Customers are charged by this list, not by raw cost.
create table price_list (
  action      text primary key,   -- 'track_creator_day', 'track_keyword_day', 'report', 'alert', 'digest'
  credits     integer not null,   -- per unit; reports are quoted per run
  unit        text not null,
  updated_at  timestamptz not null default now()
);

create type credit_kind as enum ('grant', 'purchase', 'debit', 'refund', 'adjustment');

-- Append-only. The balance is the sum; nothing is ever updated in place.
create table credit_entries (
  id               bigint generated always as identity primary key,
  workspace_id     uuid not null references workspaces (id) on delete cascade,
  kind             credit_kind not null,
  amount           integer not null,              -- positive adds, negative spends
  action           text references price_list (action),
  reference        text,                          -- the job, payment or report behind the entry
  idempotency_key  text not null unique,          -- the same charge can never land twice
  note             text,
  created_at       timestamptz not null default now(),
  check (
    (kind = 'debit' and amount < 0)
    or (kind in ('grant', 'purchase', 'refund') and amount > 0)
    or kind = 'adjustment'
  )
);
create index credit_entries_workspace on credit_entries (workspace_id, created_at);

-- Credits held while a run is in progress (e.g. an on-demand report), then settled or released.
create type reservation_status as enum ('held', 'settled', 'released');

create table credit_reservations (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces (id) on delete cascade,
  credits       integer not null check (credits > 0),
  reference     text not null,
  status        reservation_status not null default 'held',
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);

create view credit_balances as
select
  w.id as workspace_id,
  coalesce((select sum(e.amount) from credit_entries e where e.workspace_id = w.id), 0) as balance,
  coalesce((select sum(r.credits) from credit_reservations r where r.workspace_id = w.id and r.status = 'held'), 0) as held
from workspaces w;

-- The real cost of every paid Apify run and Gemini call, for margin per action.
create table cost_events (
  id            bigint generated always as identity primary key,
  provider      text not null,                    -- 'apify' | 'gemini'
  detail        text,                             -- actor id or model
  run_id        uuid,
  workspace_id  uuid references workspaces (id) on delete set null,  -- null for shared collection
  usd           numeric(12, 6) not null,
  units         jsonb,                            -- items, tokens or events
  created_at    timestamptz not null default now()
);
create index cost_events_created on cost_events (created_at);

-- ─── What workspaces track ─────────────────────────────────────────────────

create type platform as enum ('x', 'youtube', 'linkedin', 'instagram', 'tiktok', 'reddit');

create table creators (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table creator_handles (
  id                 uuid primary key default gen_random_uuid(),
  creator_id         uuid not null references creators (id) on delete cascade,
  platform           platform not null,
  handle             text not null,               -- @handle, profile slug, or r/subreddit
  url                text not null,
  verified           boolean not null default false,
  last_collected_at  timestamptz
);
create unique index creator_handles_key on creator_handles (platform, lower(handle));

create type target_kind as enum ('creator', 'keyword', 'community');

create table tracking_targets (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces (id) on delete cascade,
  kind           target_kind not null,
  creator_id     uuid references creators (id),
  query          text,                            -- brand or keyword; subreddit for communities
  platforms      platform[] not null,
  active         boolean not null default true,
  paused_reason  text,                            -- e.g. 'out_of_credits'
  created_at     timestamptz not null default now(),
  check ((kind = 'creator') = (creator_id is not null)),
  check (kind = 'creator' or query is not null)
);
create index tracking_targets_workspace on tracking_targets (workspace_id) where active;

-- ─── Collected content (shared) ────────────────────────────────────────────

create table runs (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null,                    -- 'daily', 'comments', 'report'
  workspace_id  uuid references workspaces (id),  -- set for reports, null for shared runs
  status        text not null default 'running',
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  error         text
);

create table raw_captures (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid references runs (id),
  platform        platform not null,
  source          text not null,                  -- actor id or official API
  storage_path    text not null,                  -- object storage key of the gzip JSON
  items           integer not null,
  usd             numeric(12, 6),
  parser_version  integer not null default 1,
  captured_at     timestamptz not null default now()
);

create table posts (
  id                text primary key,             -- '<prefix>_<platform id>', as in the dry run
  platform          platform not null,
  platform_post_id  text not null,
  handle_id         uuid references creator_handles (id),
  community         text,                         -- 'r/singularity' for Reddit threads
  url               text not null,
  kind              text not null,
  text              text not null default '',
  transcript        text not null default '',
  shared_urls       text[] not null default '{}',
  published_at      timestamptz not null,
  raw_capture_id    uuid references raw_captures (id),
  unique (platform, platform_post_id)
);
create index posts_published on posts (published_at desc);

-- Each collection adds a snapshot; the gap between snapshots is velocity.
create table post_metrics (
  post_id      text not null references posts (id) on delete cascade,
  captured_at  timestamptz not null default now(),
  likes        bigint,
  comments     bigint,
  shares       bigint,
  views        bigint,
  engagement   numeric,
  lift         numeric,
  primary key (post_id, captured_at)
);

create table comments (
  id            text primary key,
  post_id       text not null references posts (id) on delete cascade,
  parent_id     text,                             -- not a foreign key: parents may arrive later
  author        text not null,
  is_creator    boolean not null default false,
  likes         bigint not null default 0,
  text          text not null,
  published_at  timestamptz,
  time_approx   boolean not null default false,   -- YouTube only gives "2 days ago"
  url           text
);
create index comments_post on comments (post_id);

-- ─── Understanding (AI output) ─────────────────────────────────────────────

create table story_cards (
  post_id         text primary key references posts (id) on delete cascade,
  about           text not null,
  type            text not null,
  newsworthy      boolean not null,
  category        text not null,
  events          jsonb not null default '[]',
  model           text not null,
  prompt_version  text not null,
  created_at      timestamptz not null default now()
);

create table claims (
  id       text primary key,                      -- '<post_id>#c1'
  post_id  text not null references posts (id) on delete cascade,
  text     text not null,
  kind     text not null,
  about    text,
  stance   text,
  quote    text                                   -- null unless word for word in the post
);

create table entities (
  id    uuid primary key default gen_random_uuid(),
  name  text not null,
  type  text not null
);

-- 'astra' and 'gpt-6 astra' both point at the same entity.
create table entity_aliases (
  alias      text primary key,                    -- lower-cased
  entity_id  uuid not null references entities (id) on delete cascade
);

create table post_entities (
  post_id    text not null references posts (id) on delete cascade,
  entity_id  uuid not null references entities (id) on delete cascade,
  salience   numeric not null,
  primary key (post_id, entity_id)
);

create table comment_groups (
  id                   text primary key,          -- '<post_id>#g1'
  post_id              text not null references posts (id) on delete cascade,
  label                text not null,
  point                text not null,
  reaction_to_creator  text not null,
  tone                 text,
  comment_ids          text[] not null,
  sample_ids           text[] not null,
  model                text not null,
  prompt_version       text not null
);

-- ─── Stories ────────────────────────────────────────────────────────────────

-- The shared curated feed has no workspace; each workspace gets its own feed.
create table feeds (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references workspaces (id) on delete cascade,
  name          text not null
);
create unique index feeds_shared on feeds ((workspace_id is null)) where workspace_id is null;

create type story_status as enum ('draft', 'emerging', 'active', 'peaked', 'dormant', 'merged', 'rejected');

create table stories (
  id              uuid primary key default gen_random_uuid(),
  feed_id         uuid not null references feeds (id) on delete cascade,
  status          story_status not null default 'draft',
  category        text,
  main_entity_id  uuid references entities (id),
  merged_into     uuid references stories (id),
  first_post_at   timestamptz,
  last_post_at    timestamptz,
  heat            integer,
  published_at    timestamptz,                    -- set on approval or auto-publish
  created_at      timestamptz not null default now()
);
create index stories_feed on stories (feed_id, status, heat desc);

create table story_posts (
  story_id    uuid not null references stories (id) on delete cascade,
  post_id     text not null references posts (id) on delete cascade,
  reason      text,
  confidence  numeric,
  added_at    timestamptz not null default now(),
  primary key (story_id, post_id)
);

-- Every rewrite is a new version. Pages show the latest version that passed checks.
create table story_versions (
  id              uuid primary key default gen_random_uuid(),
  story_id        uuid not null references stories (id) on delete cascade,
  version         integer not null,
  narrative       jsonb not null,   -- main character, cast, beats, angles, evidence, reactions
  stats           jsonb not null,   -- numbers computed by code
  written         jsonb not null,   -- headline, narrative sentences, beat lines, angle blurbs
  platform_takes  jsonb not null,   -- what each platform is saying
  feed_edit       jsonb,            -- short headline, dek, platform strip
  checks          jsonb not null,   -- errors, warnings, corrected and hidden quotes
  passed          boolean not null,
  models          jsonb not null,   -- model and prompt version per step
  created_at      timestamptz not null default now(),
  unique (story_id, version)
);

-- ─── Reports, alerts and digests ───────────────────────────────────────────

create table reports (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces (id) on delete cascade,
  requested_by    uuid references users (id),
  query           text not null,
  platforms       platform[] not null,
  date_from       date not null,
  date_to         date not null,
  quoted_credits  integer not null,
  reservation_id  uuid references credit_reservations (id),
  story_id        uuid references stories (id),
  status          text not null default 'queued',
  created_at      timestamptz not null default now()
);

create table alert_rules (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces (id) on delete cascade,
  feed_id       uuid references feeds (id) on delete cascade,
  min_heat      integer not null default 50,
  channel       text not null default 'email',
  destination   text not null,
  active        boolean not null default true
);

create table notifications (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces (id) on delete cascade,
  kind          text not null,                    -- 'alert' | 'digest' | 'low_credits'
  story_id      uuid references stories (id),
  destination   text not null,
  sent_at       timestamptz,
  error         text,
  created_at    timestamptz not null default now()
);

-- ─── Development seed: draft price list (see LAUNCH_PLAN.md) ───────────────

insert into price_list (action, credits, unit) values
  ('track_creator_day', 20, 'per tracked creator per day'),
  ('track_keyword_day', 40, 'per tracked brand or keyword per day'),
  ('report',            0,  'quoted per run'),
  ('alert',             2,  'per alert sent'),
  ('digest',            5,  'per digest email');
