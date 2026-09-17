// Whether a post belongs to what a workspace follows: a followed creator's handle, a followed
// subreddit, or a search for a followed brand or topic, on one of the platforms chosen for it.
// Shared by story building and the Stories page so both pick the same posts. No imports, so the
// pipeline and the web app can both load it.
export const followedPost = (postSql, workspaceSql) => `exists (
  select 1 from tracking_targets ft
   where ft.workspace_id = ${workspaceSql} and ft.active and ${postSql}.platform = any(ft.platforms)
     and ((ft.kind = 'creator' and exists (select 1 from creator_handles fh where fh.id = ${postSql}.handle_id and fh.creator_id = ft.creator_id))
       or (ft.kind = 'community' and lower(${postSql}.community) = lower(ft.query))
       or (ft.kind = 'keyword' and exists (select 1 from post_queries fq where fq.post_id = ${postSql}.id and fq.workspace_id is null and lower(fq.query) = lower(ft.query)))))`;
