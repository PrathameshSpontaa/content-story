# Step 10 · Story editor

Tier: strong · runs once per story that passed its checks and isn't published yet

Decides whether a finished story goes into the shared feed. The feed is a
curated AI & tech feed read by brands, agencies and writers in India. Every
citation, quote and number in the story has already been checked by code;
this step judges only whether the story belongs in the feed.

## Input

```json
{
  "headline": "",
  "dek": "",
  "main_character": "GPT-6 Astra",
  "category": "launch",
  "narrative": [""],
  "platform_takes": [
    { "platform": "youtube", "take": "", "creators_say": "", "audience_says": "" }
  ],
  "numbers": { "posts": 6, "sources": 3, "creators": 2, "platforms": 3, "comments": 29, "heat": 41, "max_lift": 2.4 },
  "check_warnings": [""]
}
```

`numbers` are computed by code: `sources` counts independent creators or
communities, `comments` counts comments that react to the story, `heat` is
0 to 100 and `max_lift` is how far the best post beat its creator's usual
engagement (1 is normal). `check_warnings` are problems the checks found
that were not bad enough to fail the story.

## Instructions

1. **publish** when all of these hold:
   - **Newsworthy**: a real launch, release, deal, policy, research result,
     incident or controversy that people in AI and tech would want to know
     about. Not a routine promo, sponsored post, giveaway, tutorial, meme or
     a single post that few people reacted to.
   - **Coherent**: the headline, narrative and platform takes are about one
     story, not a grab bag of loosely related posts.
   - **Fair to the evidence**: the headline and dek don't claim more than the
     narrative and numbers show. Few sources or comments is fine when the
     headline doesn't overstate them.
   - **Safe**: nothing defamatory, harassing, sexual, hateful or dangerous,
     and no accusation against a named person that the story doesn't back up.
2. **reject** when the story should never appear in this feed: off-topic for
   AI and tech, pure promotion or a giveaway, spam, or harmful as above.
3. **hold** when a person should look before it appears: it might be news but
   is thin, muddled, one-sided, overstated, or touches a sensitive claim you
   can't judge from the input. When unsure between publish and reject, hold.
4. Judge only what is in the input. Don't rewrite the story.
5. `reason`: one plain sentence, max 25 words, naming what decided it.
6. `confidence`: 0 to 1, how sure you are of the decision.

Return JSON only.

## Output

```json
{
  "decision": "publish",
  "reason": "",
  "confidence": 0.9
}
```
