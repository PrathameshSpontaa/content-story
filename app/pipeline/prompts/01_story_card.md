# Step 2 · Story card

Tier: cheap · runs once per post

## Input

```json
{
  "post_id": "x_1834",
  "platform": "x",
  "creator": "Display Name",
  "handle": "@handle",
  "published_at": "2026-09-10T14:30:00Z",
  "kind": "post | thread | video | reel | short | article",
  "text": "the post text",
  "transcript": "video transcript, may be empty or truncated",
  "shared_urls": ["https://..."],
  "lift": 2.4
}
```

## Instructions

You read one social media post and describe it for a system that groups
posts from many creators into stories. Use only what the post says. Use
outside knowledge only to write well-known names consistently.

1. **about**: one neutral sentence (max 25 words) stating what the post is
   about as something that happened or is being argued in the world.
   Write "Inkwell moved offline sync to its paid plan", never
   "The creator talks about Inkwell".
2. **type**: `news_reaction`, `announcement`, `opinion`, `tutorial`,
   `drama`, `promo`, `personal` or `other`.
3. **noise**: `true` only when the post gives nothing to write about: a
   bare title, link or image with no subject you can tell, a greeting, or a
   joke or chit-chat that isn't about anything. Everything with a subject is
   `false`, including ads and sponsored posts, promos, tips, tutorials,
   opinions and personal updates: the people reading these stories track
   brand deals, creators' own news and what their audiences react to.
4. **entities**: people, organizations, products and events the post names
   or clearly refers to. Canonical name ("OpenAI", not "openai's new
   thing"), `type` (`person`, `org`, `product`, `event`, `place`) and
   `salience` from 0 to 1 for how central it is to this post.
5. **claims**: the distinct points the post makes, max 6.
   - `text`: the point in max 20 words
   - `kind`: `fact`, `opinion`, `prediction` or `question`
   - `about`: canonical name of the entity the point is about
   - `stance`: `supports`, `criticizes` or `neutral` toward that entity's action
   - `quote`: an exact substring of `text` or `transcript` (max 30 words)
     that shows the point, copied character for character, or `null`
6. **events**: things that happened in the world as reported by this post,
   max 4. `what` in max 15 words, past tense. `when_stated`: the date or
   time only if the post states one, else `null`.
7. **category**: one of `AI & tech`, `Business & startups`,
   `Finance & markets`, `Creator economy`, `Marketing`,
   `Politics & policy`, `Culture & entertainment`, `Science & health`,
   `Other`.

If the post is not in English, write `about`, `claims.text` and
`events.what` in English, but keep `quote` in the original language.

Return JSON only, matching the schema.

## Output

```json
{
  "post_id": "x_1834",
  "about": "",
  "type": "opinion",
  "noise": false,
  "category": "AI & tech",
  "entities": [{ "name": "", "type": "org", "salience": 0.9 }],
  "claims": [
    {
      "claim_id": "x_1834#c1",
      "text": "",
      "kind": "opinion",
      "about": "",
      "stance": "criticizes",
      "quote": ""
    }
  ],
  "events": [{ "what": "", "when_stated": null }]
}
```
