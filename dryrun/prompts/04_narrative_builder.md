# Step 6 · Narrative builder

Tier: strong · runs once per story

Finds the main character, the beats of their story, and the angles being
argued with evidence. Code has already done the counting; this step makes
the judgment calls. Code will set beat times and reaction percentages
afterwards, so this step outputs neither.

## Input

```json
{
  "story": { "story_id": "s1", "working_title": "" },
  "entity_ranking": [
    { "name": "Inkwell", "type": "product", "posts_mentioning": 38, "score": 41.2 }
  ],
  "cards": [
    {
      "post_id": "x_1834",
      "platform": "x",
      "creator": "Display Name",
      "handle": "@handle",
      "published_at": "2026-09-10T14:30:00Z",
      "lift": 3.4,
      "url": "https://...",
      "about": "",
      "type": "opinion",
      "claims": [{ "claim_id": "x_1834#c1", "text": "", "kind": "opinion", "about": "", "stance": "", "quote": "" }],
      "events": [{ "what": "", "when_stated": null }]
    }
  ],
  "comment_groups": [
    {
      "group_id": "x_1834#g1",
      "post_id": "x_1834",
      "platform": "x",
      "label": "",
      "point": "",
      "reaction_to_creator": "disagrees",
      "size": 83,
      "like_weight": 212.4,
      "samples": [{ "comment_id": "x_1834_c77", "likes": 412, "text": "" }]
    }
  ],
  "creator_replies": [{ "comment_id": "", "post_id": "", "author": "", "summary": "" }]
}
```

`entity_ranking` is computed by code: for each entity, the sum over posts
of salience × log(1 + lift).

## Instructions

**A. Main character.** The subject the creators are actually showing or
reacting to. Start from the top of `entity_ranking`, but skip an entity that
is a platform or a generic term ("YouTube", "AI", "startups"), or that only
provides context (the agency whose footage was used, the venue of a launch).
For a launch event, pick the headline product, or the company if several
products share the attention. Say why in `main_character.reason`.
Add 2 to 4 `supporting_cast` entries, each with its role in this story in
max 6 words.

**B. Beats.** Tell the main character's story as 3 to 7 moments, in order.
Build them from card `events` and from posts that mark a change: the
announcement, the first criticism that took off, a response from the main
character, a reversal, a new fact. For each beat:
- `what`: max 18 words, past tense
- `source_post_ids`: every post that reports this moment (the earliest
  one sets the beat's time in code)
- `source_comment_ids`: comments that are themselves the moment (for
  example a reply from the main character), else empty
- `turning_point_candidate`: `true` if reaction likely changed after it,
  with a one-line `reason`

Do not write dates or times.

**C. Angles.** An angle is a point people are arguing about the main
character. Group claims from different posts that make the same point.
Each angle needs support from at least 2 different sources (a source is a
creator, or a comment group), or 1 post with `lift` of 3 or more. Make 2
to 5 angles. For each:
- `title`: max 6 words, the way people would say it ("It's a cash grab")
- `thesis`: one sentence
- `kind`: `opinion`, `fact` or `question`
- `evidence`: list of `{ "source_id", "post_id", "relation", "note" }`
  where `source_id` is a `claim_id`, `comment_id` or `group_id` from the
  input, `relation` is `supports`, `contradicts`, `answers` or `asks`,
  and `note` is max 15 words. Include contradicting evidence when it exists.

**D. Reactions.** For every comment group, add one entry for EACH angle
the group clearly takes a side on or asks about:
`{ "group_id", "angle_index", "relation" }` with `relation` `agrees`,
`disagrees` or `asks`. A group may have several entries. A group that backs
one angle usually disagrees with the angle opposite it, so record both;
otherwise every angle shows only its supporters and reads as 100% agreement.
Add a single entry with `angle_index: null` only when the group responds to
no angle at all.

**E. Open questions.** Questions asked in several places that nothing in
the input answers, each with the `group_id`s or `comment_id`s asking it.

Every ID you output must appear in the input. Never invent a source.
Return JSON only.

## Output

```json
{
  "story_id": "s1",
  "main_character": { "name": "", "reason": "" },
  "supporting_cast": [{ "name": "", "role": "" }],
  "beats": [
    {
      "what": "",
      "source_post_ids": [],
      "source_comment_ids": [],
      "turning_point_candidate": false,
      "reason": ""
    }
  ],
  "angles": [
    {
      "title": "",
      "thesis": "",
      "kind": "opinion",
      "evidence": [{ "source_id": "", "post_id": "", "relation": "supports", "note": "" }]
    }
  ],
  "reactions": [{ "group_id": "", "angle_index": 0, "relation": "agrees" }],
  "open_questions": [{ "question": "", "asked_in": [] }]
}
```
