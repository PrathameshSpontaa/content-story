# Step 8 · Story writer

Tier: strong · runs once per story

Turns the narrative builder's structure and code's numbers into the words
on the story page. It adds no facts and computes no numbers.

## Input

```json
{
  "narrative": "the full output of step 6",
  "numbers": {
    "creators": 8,
    "platforms": 5,
    "heat": 87,
    "beat_times": ["2026-09-07T09:10:00Z"],
    "turning_points": [1, 3],
    "angle_reactions": [
      {
        "angle_index": 0,
        "by_platform": [{ "platform": "tiktok", "agree_pct": 74, "disagree_pct": 26, "asks": 20, "comments": 1100 }]
      }
    ],
    "reaction_shifts": [
      { "angle_index": 0, "platform": "youtube", "before_pct": 63, "after_pct": 51, "after_beat": 3 }
    ]
  },
  "sources": {
    "posts": [{ "post_id": "", "platform": "", "handle": "", "text": "", "transcript_excerpt": "" }],
    "comments": [{ "comment_id": "", "post_id": "", "author": "", "likes": 0, "text": "" }]
  }
}
```

## Instructions

`tag`, when present, is the kind of story the reader asked for (for example
a brand deal, a creator's own news, or a post that broke out). Lead with
what makes it that kind of story: for a brand deal, name the creator and the
brand; for a breakout, say what took off.

1. **headline**: max 16 words. Names the main character, says what
   happened, and what is contested if something is. No questions, no
   clickbait, no exclamation marks.
2. **narrative**: 3 to 5 sentences about the main character, in time
   order. Say where creators and communities disagree. End every sentence
   with the IDs that support it in square brackets, like `[x_1834, yt_22]`.
   Use a number only if it appears in `numbers`.
3. **beat_lines**: one line per beat, max 18 words, same order as the
   input beats.
4. **angle_blurbs**: one per angle, 1 to 2 sentences on who argues it and
   how each audience responds, using `angle_reactions`. Cite IDs the same way.
5. **quotes**: up to 3 quotes copied exactly from `sources`, each with its
   `source_id`. Pick ones that show the disagreement.
6. Name platforms and handles instead of writing "a creator" or "users".
   Neutral voice. Nothing that isn't in the input.

Return JSON only.

## Output

```json
{
  "story_id": "s1",
  "headline": "",
  "narrative": [{ "sentence": "", "cites": ["x_1834"] }],
  "beat_lines": [""],
  "angle_blurbs": [{ "angle_index": 0, "text": "", "cites": [] }],
  "quotes": [{ "text": "", "source_id": "" }]
}
```
