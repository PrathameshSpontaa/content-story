# Step 4 · Group posts into stories

Tier: strong · runs once over the whole week

In the real app, links and similarity scores shortlist candidates and the
strong model only settles unclear cases. The dry run is small enough
(a few hundred posts at most) to hand the model every newsworthy card at
once. This is the blueprint's nightly "group the unassigned pool" path.

## Input

```json
{
  "window": { "from": "2026-09-06", "to": "2026-09-13" },
  "cards": [
    {
      "post_id": "x_1834",
      "platform": "x",
      "creator": "Display Name",
      "published_at": "2026-09-10T14:30:00Z",
      "lift": 3.4,
      "about": "",
      "entities": ["Inkwell"],
      "claims": ["it's a cash grab"],
      "shared_urls": ["https://inkwell.app/blog/pricing"],
      "quotes_post_id": null
    }
  ],
  "existing_stories": [
    {
      "story_id": "7d7c5595-30dc-4272-9f47-491563152ae0",
      "main_entity": "Inkwell",
      "headline": "Inkwell moves offline sync to its paid plan",
      "last_post_at": "2026-09-09T08:00:00Z",
      "post_ids": ["x_1790", "yt_18"]
    }
  ]
}
```

`cards` are new posts that are not in any story yet. `existing_stories` are
the stories already in this feed, with their earlier posts (which are not in
`cards`). It may be empty.

## Instructions

1. A **story** is one specific real-world event, change, launch, deal,
   release or controversy. "AI regulation" is a topic, not a story.
   "EU delays enforcement of the AI Act" is a story.
2. Put posts together only if they are about the same specific event, or a
   direct response to or consequence of it. Mentioning the same company is
   not enough.
3. **Certain links**: posts sharing the same URL, or a post that quotes or
   responds to another post in the input, belong to the same story.
4. A story needs at least 2 posts from at least 2 different creators, or
   1 post with `lift` of 3 or more. Leave other posts in `unassigned`.
5. For each story: `working_title` (max 12 words, names who and what),
   `post_ids`, `why` (one sentence on what ties them together) and
   `confidence` from 0 to 1.
6. List every post you placed with less than 0.7 confidence in
   `uncertain`, with the other option you considered.
7. A post belongs to at most one story.
8. **Attach to an existing story** when new posts are about the same event
   as a story in `existing_stories`: output that story with its `story_id`
   copied into `existing_story_id`, and only the NEW post_ids in `post_ids`.
   Never start a new story for an event that already has one. A new story
   has `existing_story_id: null`. Leave out existing stories that get no
   new posts.
9. Merge rather than split when readers would see one event: different
   products launched at the same keynote are one story, and the same tool
   shown by the same creator in the same week is one story. Split only when
   the audiences are arguing about genuinely different things.

Return JSON only.

## Output

```json
{
  "stories": [
    {
      "story_id": "s1",
      "existing_story_id": null,
      "working_title": "",
      "post_ids": ["x_1834", "yt_22"],
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
