# Step 4 · Group a watchlist's posts into stories

Tier: strong · runs once per watchlist per refresh

## Input

```json
{
  "watchlist": "boAt launches",
  "tags": [
    {
      "name": "Brand deals",
      "rule": "A creator promotes, reviews or partners with a brand: sponsored or paid posts, affiliate links and codes, giveaways.",
      "min_sources": 1
    },
    {
      "name": "Trends",
      "rule": "Several creators on the same theme, format, meme or opinion this week, even with no single event behind it.",
      "min_sources": 2
    }
  ],
  "brands": ["boAt", "Noise"],
  "window": { "from": "2026-09-06", "to": "2026-09-13" },
  "cards": [
    {
      "post_id": "x_1834",
      "platform": "x",
      "creator": "Display Name",
      "published_at": "2026-09-10T14:30:00Z",
      "lift": 3.4,
      "type": "promo",
      "about": "",
      "entities": ["boAt Airdopes"],
      "claims": ["the battery lasts two days"],
      "shared_urls": ["https://boat-lifestyle.com/..."],
      "quotes_post_id": null
    }
  ],
  "existing_stories": [
    {
      "story_id": "7d7c5595-30dc-4272-9f47-491563152ae0",
      "tag": "Brand deals",
      "main_entity": "boAt",
      "headline": "Three tech creators promote boAt's new earbuds in the same week",
      "last_post_at": "2026-09-09T08:00:00Z",
      "post_ids": ["x_1790", "yt_18"]
    }
  ]
}
```

A watchlist is what one team follows for one client, campaign or interest.
`tags` are the kinds of story it wants, in its own words. `brands` are the
brands and topics it follows (it may be empty). `cards` are its new posts
that are not in any story yet. `existing_stories` are its stories so far,
with their earlier posts (not in `cards`). `lift` is how the post did
against the creator's usual posts: 3 means three times their usual
engagement.

## Instructions

1. Only make stories that fit one of the `tags`. Read each tag's `rule`:
   it says what counts. Give every story exactly one tag, copying its
   `name`. When a story fits several, pick the tag whose rule it matches
   most specifically. Leave posts that fit no tag in `unassigned`.
2. A story is one thing a reader of this watchlist would want to know: a
   brand deal, a launch, a post that took off, a theme several creators
   are on, an event. Put posts together only when a reader would see them
   as the same thing: the same deal or campaign, the same announcement,
   the same event, the same theme or format this week. Mentioning the same
   company is not enough.
3. **Certain links**: posts sharing the same URL, or a post that quotes or
   responds to another post in the input, belong to the same story.
4. A tag with `min_sources: 2` needs at least 2 posts from 2 different
   creators or communities, or 1 post with `lift` of 3 or more. A tag with
   `min_sources: 1` can be a story from a single post.
5. When `brands` is not empty, prefer stories that involve those brands,
   but don't drop a story that fits a tag only because it names another
   brand.
6. For each story: `tag`, `working_title` (max 12 words, names who and
   what), `post_ids`, `why` (one sentence on what ties them together and
   why it fits the tag) and `confidence` from 0 to 1.
7. List every post you placed with less than 0.7 confidence in
   `uncertain`, with the other option you considered.
8. A post belongs to at most one story.
9. **Attach to an existing story** when new posts are about the same thing
   as a story in `existing_stories`: output that story with its `story_id`
   copied into `existing_story_id`, its `tag`, and only the NEW post_ids in
   `post_ids`. Never start a new story for something that already has one.
   A new story has `existing_story_id: null`. Leave out existing stories
   that get no new posts.

Return JSON only.

## Output

```json
{
  "stories": [
    {
      "story_id": "s1",
      "existing_story_id": null,
      "tag": "Brand deals",
      "working_title": "",
      "post_ids": ["x_1834"],
      "why": "",
      "confidence": 0.9
    }
  ],
  "unassigned": ["li_9"],
  "uncertain": [
    { "post_id": "", "placed_in": "s1", "alternative": "unassigned", "reason": "" }
  ]
}
```
