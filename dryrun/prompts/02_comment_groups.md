# Step 3 · Comment groups

Tier: cheap · runs once per post that has comments

In the real app, comments are grouped with local embeddings and the cheap
model only names the groups. In the dry run the model does both, but it
must list every comment ID in its group, so code can count sizes and
percentages. The model never outputs a number.

## Input

```json
{
  "post": {
    "post_id": "x_1834",
    "platform": "x",
    "creator": "Display Name",
    "handle": "@handle",
    "text": "the post text or a summary of the video"
  },
  "comments": [
    {
      "comment_id": "x_1834_c77",
      "parent_id": null,
      "author": "@someone",
      "is_creator": false,
      "likes": 412,
      "text": "the comment"
    }
  ]
}
```

## Instructions

1. Put spam, bots, self-promotion, emoji-only, "first!", and comments that
   have nothing to do with the post into `dropped`.
2. Group the rest by the **point** they make, not just by mood. Two angry
   comments about different things belong in different groups. Aim for
   3 to 8 groups. Every kept comment goes in exactly one group.
3. For each group:
   - `label`: max 8 words, plain language a reader would recognize
     ("Doubts the price is fair", not "Negative pricing sentiment")
   - `point`: one sentence on what the group is saying
   - `reaction_to_creator`: `agrees`, `disagrees`, `asks`, `jokes`,
     `adds_info` or `other`
   - `tone`: `serious`, `joking`, `angry`, `supportive` or `mixed`
   - `comment_ids`: every comment in the group
   - `sample_ids`: up to 5 IDs that best show the group, most-liked first
4. A reply is about its parent comment, not the post. Read `parent_id`
   before deciding what a reply agrees or disagrees with.
5. `creator_replies`: every comment where `is_creator` is `true`, with a
   max 15-word summary of what the creator said.

Do not write counts, percentages or totals anywhere. Return JSON only.

## Output

```json
{
  "post_id": "x_1834",
  "dropped": ["x_1834_c3"],
  "groups": [
    {
      "group_id": "x_1834#g1",
      "label": "",
      "point": "",
      "reaction_to_creator": "disagrees",
      "tone": "serious",
      "comment_ids": ["x_1834_c77"],
      "sample_ids": ["x_1834_c77"]
    }
  ],
  "creator_replies": [{ "comment_id": "", "summary": "" }]
}
```
