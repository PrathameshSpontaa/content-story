// Whether a post belongs to what a workspace follows: a followed creator's handle, a followed
// subreddit, or a search for a followed brand or topic, on one of the platforms chosen for it.
// No imports, so the pipeline and the web app can both load it.
const matchesTarget = (postSql) => `${postSql}.platform = any(ft.platforms)
     and ((ft.kind = 'creator' and exists (select 1 from creator_handles fh where fh.id = ${postSql}.handle_id and fh.creator_id = ft.creator_id))
       or (ft.kind = 'community' and lower(${postSql}.community) = lower(ft.query))
       or (ft.kind = 'keyword' and exists (select 1 from post_queries fq where fq.post_id = ${postSql}.id and fq.workspace_id is null and lower(fq.query) = lower(ft.query))))`;

export const followedPost = (postSql, workspaceSql) => `exists (
  select 1 from tracking_targets ft
   where ft.workspace_id = ${workspaceSql} and ft.active and ${matchesTarget(postSql)})`;

// The same for one watchlist: a post from one of the active follows in it. Story building uses this.
export const watchlistPost = (postSql, watchlistSql) => `exists (
  select 1 from watchlist_targets fw join tracking_targets ft on ft.id = fw.target_id
   where fw.watchlist_id = ${watchlistSql} and ft.active and ${matchesTarget(postSql)})`;
