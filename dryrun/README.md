# Content-Story dry run

A throwaway test of the story pipeline before building the real thing.
No database, no scrapers, no Gemini: JSON files on disk, Apify for data,
and Claude models standing in for the two AI tiers.

| Tier in the blueprint | Real app            | Dry run        |
|-----------------------|---------------------|----------------|
| cheap                 | Gemini Flash-Lite   | Claude Haiku   |
| strong                | Gemini Flash        | Claude Sonnet  |

## Steps

| # | Step               | Who          | Input                                  | Output                         |
|---|--------------------|--------------|----------------------------------------|--------------------------------|
| 0 | Collect            | Apify        | creators list                          | `data/raw/<platform>/*.json`   |
| 1 | Normalize          | code         | raw files                              | `data/posts.json`, `data/comments.json` |
| 2 | Story cards        | cheap AI     | one post                               | `data/cards/<post_id>.json`    |
| 3 | Comment groups     | cheap AI     | one post + its comments                | `data/groups/<post_id>.json`   |
| 4 | Group into stories | strong AI    | all newsworthy cards                   | `data/stories.json`            |
| 5 | Story numbers      | code         | cards, groups, metrics                 | `data/stats/<story_id>.json`   |
| 6 | Narrative builder  | strong AI    | one story's cards, groups, stats       | `data/narrative/<story_id>.json` |
| 7 | Reaction numbers   | code         | narrative + groups                     | `data/stats/<story_id>.json`   |
| 8 | Story writer       | strong AI    | narrative + numbers                    | `data/written/<story_id>.json` |
| 8b| Platform lens      | strong AI    | each platform's posts, groups, numbers | `data/lens/<story_id>.json`    |
| 8c| Feed editor        | strong AI    | written story + platform lens          | `data/edit/<story_id>.json`    |
| 9 | Citation check     | code         | written story + sources                | pass / fail list               |
| 10| Render             | code         | everything above                       | `out/<story_id>.html`          |

AI steps live in `prompts/`. They are written as plain API prompts
(input → JSON out) so the same files can move to Gemini later.

## Running it

Requires Node 22+ and an Apify token in `.env`. From the `dryrun` folder:

```bash
node scripts/collect.mjs plan
```

```bash
node scripts/collect.mjs posts
```

```bash
node scripts/normalize.mjs
```

```bash
node scripts/collect.mjs comments
```

```bash
node scripts/normalize.mjs
```

Then, for each AI step: `node scripts/prepare.mjs <cards|groups|grouping|builder|writer>`
builds its input files, the model runs the matching prompt in `prompts/`, and the
code steps run in between: `stats.mjs` after the builder, `verify.mjs` after the
writer, and `render.mjs` last. Open `out/index.html`.

Settings for each scraper, and what they cost, are in `config/actors.md`.
The creators and subreddits are in `config/creators.json`.

## Rule that carries over to the real app

The AI extracts and writes. Code does every count, percentage, time and
ID check. If a number on the story page didn't come from code, it's a bug.
