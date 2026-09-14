-- Following page: the profile photo a channel gives us (when it gives one), and indexes for each
-- source's weekly numbers.
alter table creator_handles add column avatar_url text;

create index posts_handle_published on posts (handle_id, published_at desc) where handle_id is not null;
create index posts_community_published on posts (lower(community), published_at desc) where community is not null;
