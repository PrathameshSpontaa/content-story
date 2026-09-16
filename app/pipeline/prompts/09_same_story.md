# Step 11 · Same story?

Tier: strong · runs once per pair of stories the split check flags

Code flags two stories in the feed that share a main entity and whose post
dates overlap. This step decides whether readers would see them as one story
told twice, and if so which one to keep. Code does the merge.

## Input

```json
{
  "a": {
    "headline": "",
    "dek": "",
    "main_entity": "Anthropic",
    "first_post_at": "2026-09-11T15:59:00Z",
    "last_post_at": "2026-09-13T05:00:00Z",
    "category": "policy",
    "post_count": 3,
    "posts": [{ "platform": "tiktok", "published_at": "2026-09-11T15:59:00Z", "about": "" }]
  },
  "b": { "...": "same shape as a" }
}
```

`posts` holds up to 8 of each story's posts, each with the one-line `about`
from its card. `post_count` is the story's full number of posts.

## Instructions

1. **same_story** is true when both are about the same specific event,
   change, launch, deal, release or controversy, or one is a direct
   response to or consequence of the other. Different products launched at
   the same event are one story.
2. Sharing a company or person is not enough. Two different launches, two
   separate incidents, or the same company in two unrelated arguments are
   different stories: `same_story` is false.
3. **keep** is the story that should survive the merge: the broader one with
   more sources and the clearer headline. When it's close, keep the one with
   more posts. When `same_story` is false, still fill it with "a".
4. `reason`: one plain sentence, max 25 words, naming the event they share
   or what sets them apart.
5. `confidence`: 0 to 1, how sure you are of `same_story`.

Return JSON only.

## Output

```json
{
  "same_story": true,
  "keep": "a",
  "reason": "",
  "confidence": 0.8
}
```
