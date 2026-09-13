# Step 9 · Feed editor

Tier: strong · runs once per story, last

Makes a finished story scannable. The writer's headline explains the story;
this step sharpens it for the feed, adds a one-sentence summary of where
people split, and gives each platform a few words so a reader sees the
cross-platform picture without opening the story.

## Input

```json
{
  "story_id": "s4",
  "main_character": "GPT-6 Astra",
  "current_headline": "",
  "narrative": [""],
  "contrast": [""],
  "platform_takes": [
    { "platform": "youtube", "take": "", "creators_say": "", "audience_says": "" }
  ],
  "numbers": { "creators": 1, "sources": 2, "platforms": 3, "posts": 6, "comments": 29 }
}
```

## Instructions

1. **headline**: max 12 words. Names the main character and the news or the
   tension. Present tense. One clause: no colon or semicolon joining two
   headlines. No trailing period, no question, no clickbait, no hype words
   ("stunning", "insane", "game-changer").
2. **dek**: one sentence, max 30 words, saying where creators and platforms
   split. Name platforms. Use a number only if it appears in `numbers`.
3. **platform_strip**: one entry per platform in `platform_takes`, same order.
   `gist` is max 8 words in plain language, lower-case start, no trailing
   period: "calls it a breakthrough", "treats it as a meme".
4. Nothing that isn't in the input. Neutral voice.

Return JSON only.

## Output

```json
{
  "story_id": "s4",
  "headline": "",
  "dek": "",
  "platform_strip": [{ "platform": "youtube", "gist": "" }]
}
```
