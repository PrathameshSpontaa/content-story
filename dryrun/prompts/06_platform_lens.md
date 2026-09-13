# Step 8b · What each platform is saying

Tier: strong · runs once per story, alongside the story writer

The story page leads with our own write-up of the story. This step adds the
view across channels: for each platform, what its creators and its audience
are saying about the main character, and how that differs from the other
platforms. Everything stays tied to evidence from that platform.

## Input

```json
{
  "story": {
    "story_id": "s3",
    "working_title": "",
    "main_character": "iPhone Duo",
    "angles": [{ "angle_index": 0, "title": "", "thesis": "" }]
  },
  "platforms": [
    {
      "platform": "youtube",
      "creators": ["Marques Brownlee (MKBHD) (@mkbhd)"],
      "posts": [
        {
          "post_id": "yt_abc", "creator": "", "handle": "", "kind": "video", "published_at": "", "lift": 2.1,
          "about": "", "claims": [{ "claim_id": "yt_abc#c1", "text": "", "stance": "", "quote": "" }],
          "text_excerpt": ""
        }
      ],
      "comment_groups": [
        {
          "group_id": "yt_abc#g1", "post_id": "yt_abc", "label": "", "point": "", "reaction_to_creator": "disagrees", "size": 7,
          "samples": [{ "comment_id": "ytc_1", "likes": 412, "text": "" }]
        }
      ],
      "numbers": {
        "posts": 4,
        "comments_grouped": 63,
        "angle_agreement": [{ "angle_index": 0, "agree_pct": 49, "comments": 26, "asks": 1 }]
      }
    }
  ]
}
```

`numbers` is computed by code. `agree_pct` is the share of that platform's
comments on the angle that agree with it, weighted by likes.

## Instructions

For **each platform in the input, in the same order**, write:

1. **take**: max 14 words. What this platform is mainly saying about the main
   character, phrased as the take itself, e.g. "LinkedIn treats Astra as an
   org-design problem, not a model launch".
2. **creators_say**: 1 to 2 sentences on what the creators on this platform
   said, naming them. For Reddit, describe what the thread itself said. Cite
   the post_ids or claim_ids you used.
3. **audience_says**: 1 to 2 sentences on what commenters on this platform
   said, or `null` if the platform has no comment groups. Cite group_ids or
   comment_ids. If you give a percentage from `angle_agreement`, also say how
   many comments it is based on, and don't give one based on fewer than 5.
4. **quote**: one short quote copied character for character from a post's
   `text_excerpt` or `claims[].quote`, or from a comment sample's `text`, on
   THIS platform, that best captures its take. Give its post_id or comment_id
   as `source_id`. Use `null` if nothing fits.
5. **distinct**: one sentence on what is said on this platform that isn't said
   on the others, or how its tone differs. If this is the only platform, say
   what stands out about its audience instead.

Then write **contrast**: 2 to 3 sentences across all platforms: where they
agree, and where they split. Cite IDs from the input.

Rules:
- Only cite IDs that appear in the input, and cite a platform's own evidence
  in its own card.
- Use only numbers that appear in `numbers`.
- Name creators and platforms. Neutral voice. No facts that aren't in the input.

Return JSON only.

## Output

```json
{
  "story_id": "s3",
  "contrast": [{ "sentence": "", "cites": ["yt_abc", "x_123#g2"] }],
  "platforms": [
    {
      "platform": "youtube",
      "take": "",
      "creators_say": { "text": "", "cites": ["yt_abc#c1"] },
      "audience_says": { "text": "", "cites": ["yt_abc#g1"] },
      "quote": { "text": "", "source_id": "ytc_1" },
      "distinct": ""
    }
  ]
}
```
