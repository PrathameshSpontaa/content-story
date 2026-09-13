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
  ]
}
```

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
8. Merge rather than split when readers would see one event: different
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
