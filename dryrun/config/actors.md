# Apify actors: verified inputs, outputs, pricing (dry-run reference)

Verified on **2026-09-13**. No actors were run and no token was used.

**Sources used.** Each bullet names a source and what was taken from it.
- **Input schemas:** the public build endpoint `GET https://api.apify.com/v2/acts/<user>~<actor>/builds/default`. Its `inputSchema` field is the live input schema. It also carries the dataset schema (`actorDefinition.storages.dataset`), the README and the changelog.
- **Pricing and default run options:** `GET https://api.apify.com/v2/acts/<user>~<actor>`, using the last `pricingInfos` entry. No future-dated price changes were listed.
- **API details:** the OpenAPI spec at `https://docs.apify.com/api/openapi.json`, plus docs.apify.com pages.

**Legend.** Anything not confirmed by one of those sources is marked **UNVERIFIED**. "README stale" means the actor's README shows an older price than the live pricing API.

**Dates used in the examples:**
- 7-day window: `2026-09-06` to `2026-09-13`
- UNIX seconds: `since_time:1788652800`, `until_time:1789257600`
- All 11 actors are currently **PAY_PER_EVENT**. Prices below are the `FREE` tier (the Free plan gets no Store discount).

---

## 0. Apify REST API (verified against OpenAPI spec)

| Item | Verified value |
|---|---|
| Base URL | `https://api.apify.com` |
| Auth | `Authorization: Bearer <token>`. This is the recommended scheme (`httpBearer` in the spec). The alternative is the `?token=` query param. |
| Actor ID in path | `username~actor-name` (tilde). Spec: "Actor ID or the username of the Actor owner and the Actor name, separated by a tilde (`~`)". |
| Path prefix | The spec now documents **`/v2/actors/{actorId}/...`**. The legacy **`/v2/acts/{actorId}/...`** still routes: tokenless GET on both returned the same actor object, and both runs endpoints returned `token-not-provided` rather than 404. Use `/v2/actors/`. |

### Synchronous: run and get dataset items
- **Endpoint:** `POST https://api.apify.com/v2/actors/{username~actor}/run-sync-get-dataset-items`
- **Body:** the actor input JSON, with `Content-Type: application/json`.
- **Response:** default-dataset items. The spec lists the success code as `201`.
- **Run query params:** `timeout` (s), `memory` (MB), `maxItems`, `maxTotalChargeUsd`, `build`, `restartOnError`, `webhooks`.
- **Dataset query params:** `format` (json default), `clean`, `fields`, `omit`, `limit`, `offset`, `desc`, `unwind`, `flatten`, `view`.
- **Max wait:** 300 s. Spec: "If the Actor run exceeds 300 seconds, the HTTP response will return the 408 status code (Request Timeout)". It also warns that if the connection breaks, "you will not receive any information about the run".
- **What happens to the run on timeout:**
  - The API reference does not say the run is aborted.
  - The Apify Academy page says a sync call past 5 minutes returns a run object with status `RUNNING`.
  - Treat the run as **still running and still charging**. Recover it with `GET /v2/actors/{actorId}/runs/last` and then its dataset. That the run keeps going after a 408 is **UNVERIFIED** (the docs pages disagree on the response).
- **Only the default dataset is returned.** Anything written elsewhere is not in the sync response. Examples: TikTok `commentsDatasetUrl` datasets, YouTube `transcriptionUrl` KV records, TikTok subtitle files.

### Asynchronous: start, poll, fetch
1. **Start:** `POST https://api.apify.com/v2/actors/{username~actor}/runs`
   - Optional `?waitForFinish=0..60` ("By default it is `0`, the maximum value is `60`").
   - Also accepts `timeout`, `memory`, `maxItems`, `maxTotalChargeUsd`, `build`.
   - Returns `201` with `data.id`, `data.status` and `data.defaultDatasetId`.
2. **Poll:** `GET https://api.apify.com/v2/actor-runs/{runId}?waitForFinish=60`. Repeat until `status` is terminal.
   - Statuses: `READY`, `RUNNING`, `SUCCEEDED`, `FAILED`, `TIMING-OUT`, `TIMED-OUT`, `ABORTING`, `ABORTED`.
   - The run object has `usageTotalUsd` (needs a token) and `chargedEventCounts` (event to count).
   - Spec: the first response after completion "can still show preliminary `stats`, costs, and event counts. For stable figures, wait about 10 seconds and call the endpoint again."
3. **Fetch items:** `GET https://api.apify.com/v2/datasets/{defaultDatasetId}/items?format=json&clean=true`
   - Shortcut: `GET https://api.apify.com/v2/actor-runs/{runId}/dataset/items`.
   - Pagination: `limit`/`offset`, with `X-Apify-Pagination-Total|Offset|Limit|Count` headers. There is no default limit.
4. **Abort (safety):** `POST https://api.apify.com/v2/actor-runs/{runId}/abort`.
   - Alternatives: `POST /v2/actors/{actorId}/runs/last/abort`.
   - Last-run helpers: `GET /v2/actors/{actorId}/runs/last` and `/runs/last/dataset/items`.

### `maxItems` and `maxTotalChargeUsd` query params
Both are accepted on `/runs` and `/run-sync-get-dataset-items`.

- **`maxItems`**, spec wording: "maximum number of dataset items that will be charged for **pay-per-result** Actors. This does NOT guarantee that the Actor will return only this many items... **Only works for pay-per-result Actors**." (It is exposed to the actor as env `ACTOR_MAX_PAID_DATASET_ITEMS`.)
  - All 11 actors here are pay-per-event, so do not rely on `maxItems` as a spending cap.
  - Whether it still applies to PPE actors that use the synthetic `apify-default-dataset-item` event (e.g. the X actor) is **UNVERIFIED**.
- **`maxTotalChargeUsd`**, spec wording: "maximum total cost of the run. Use it to cap the total amount charged for all pricing models." (Env: `ACTOR_MAX_TOTAL_CHARGE_USD`.)
  - PPE docs: when reached, "`Actor.charge()` stop charging and `Actor.pushData()` stops pushing data over the limit. The platform then aborts the run automatically".
  - Store docs: "you are never charged for produced events over the defined limit".
  - **Use this on every call.**
- **Per-actor floor `minimalMaxTotalChargeUsd`** (listed per actor below). This is the minimum value a user may set as the max charge, taken from a docs search summary.
  - What happens if you pass a lower value (rejected, or silently raised) is **UNVERIFIED**. Always pass at least the floor.
- Note: the body field `maxItems` used by some actors (X, LinkedIn comments) is a different thing from the `maxItems` query param.

### PowerShell call shape (untested, no token available)
```powershell
$h = @{ Authorization = "Bearer $env:APIFY_TOKEN" }
$body = $inputObject | ConvertTo-Json -Depth 10
$uri = "https://api.apify.com/v2/actors/clockworks~tiktok-comments-scraper/run-sync-get-dataset-items?maxTotalChargeUsd=0.25&format=json&clean=true"
$items = Invoke-RestMethod -Method Post -Uri $uri -Headers $h -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 330
```

### Free plan (platform)
- **Prepaid usage:** $5/month (apify.com/pricing and several READMEs).
- **Store discount:** none, so all prices below are the `FREE` tier.
- **Memory:** max Actor memory 16,384 MB (docs.apify.com/platform/limits). Every default memory below fits.
- **Concurrent runs: UNVERIFIED.** The pricing-page summary said 5; the limits doc said 25. Run sequentially.
- **Rental Actors:** "Limited (trial only)". None of the 11 actors is a rental; all are PPE.
- **Actor-imposed Free-plan limits:** listed per actor below. **X and Instagram comments are the ones that matter.**

---

## 1. kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest

- **Actor ID:** `CJdippxWmn9uRfooo`
- **Default build:** `latest0225` (1.0.514, built 2026-09-12)
- **Default run options:** memory 256 MB, timeout 0 (none)

### Inputs (from live schema; only `maxItems` is required)

| Field | Type | Enum / default | Notes |
|---|---|---|---|
| `searchTerms` | array of strings | none | Twitter advanced-search strings, one run per term. If set, it overrides `twitterContent`, and **`maxItems` becomes the cap per term**. |
| `twitterContent` | string | none | Single query string. Here `maxItems` is the total cap. |
| `tweetIDs` | array of strings | none | "When this field has a value, all other filter conditions will be ignored." |
| `maxItems` | integer | default `200`, min 1, max 1000000 | Description: "The minimum value is 20", and it is "the minimum number of items to return, not a strict limit". You may get slightly more than asked. |
| `queryType` | string | `Latest` \| `Top` \| `Photos` \| `Videos`, default `Latest` | |
| `lang` | string | ISO 639-1 codes, no default | |
| `from` | string | none | One username only. |
| `to`, `@`, `list` | string | none | |
| `since_time`, `until_time` | string | none | UNIX seconds. |
| `since_id`, `max_id` | string | none | |
| `conversation_id` | string | none | "Tweets that are part of a thread (direct replies and other replies)". |
| `filter:replies`, `filter:nativeretweets`, `include:nativeretweets`, `filter:quote`, `filter:media`, ... | boolean | default `false` | |
| `min_retweets`, `min_faves`, `min_replies`, `-min_retweets`, `-min_faves`, `-min_replies` | integer | default `0` | |

**README changelog warnings (current):**
- "`since` / `until` filters are no longer reliable... use `since_time` and `until_time` (UNIX timestamps)".
- "Each query returns a limited number of tweets (typically up to ~20). Pagination is not reliable... split your queries into smaller time windows".

### Example (a): tweets from handles, last 7 days, max N total
Use `twitterContent` so `maxItems` is a total:
```json
{
  "twitterContent": "(from:HANDLE_1 OR from:HANDLE_2 OR from:HANDLE_3) since_time:1788652800 until_time:1789257600",
  "queryType": "Latest",
  "maxItems": 20
}
```
For a cap per handle, use `"searchTerms": ["from:HANDLE_1 since_time:1788652800 until_time:1789257600", "from:HANDLE_2 since_time:1788652800 until_time:1789257600"]` with `"maxItems": 20`, which then means 20 per term.

Combining the OR-query in `twitterContent` with the structured `from` field is **UNVERIFIED**, so leave the structured fields unset.

### Example (b): replies to a tweet, max N per tweet
```json
{
  "searchTerms": ["conversation_id:TWEET_ID_1", "conversation_id:TWEET_ID_2"],
  "queryType": "Latest",
  "maxItems": 20
}
```

### Output fields
- **Identity and text:**
  - `id`, `url`, `twitterUrl`, `text`, `lang`, `source`
  - `createdAt`, in the format `"Thu Oct 17 09:30:41 +0000 2024"`. This is not ISO; parse it.
- **Author:** `author.userName` (handle), `author.id`, `author.name`, `author.isBlueVerified`, `author.followers`.
- **Engagement:** `likeCount`, `replyCount`, `retweetCount`, `quoteCount`, `bookmarkCount`, `viewCount`.
- **Reply linkage:** `isReply`, `inReplyToId`, `inReplyToUserId`, `inReplyToUsername`, `conversationId`.
- **Type flags:** `isRetweet`, `isQuote`, `isPinned`, `type` (`"tweet"`).
- **Creator replying:** no dedicated flag. Detect `author.userName == <root author handle>` (or `author.id == inReplyToUserId` of the root) within `conversationId`. The root tweet itself may appear, with `id == conversationId`.
- **Subtitles/transcripts:** none.

### Pricing
- `apify-default-dataset-item` ("tweet"): FREE **$0.00025, i.e. $0.25/1k. Confirmed.**
- Paid tiers go down to $0.18/1k.
- No start event. `minimalMaxTotalChargeUsd` is null.

### Free-plan and other risks: HIGH
- **Free plan cap:**
  - The README has a "⚠️ Free user limitations" section: "free users are restricted in the number of tweets they can scrape".
  - A public issue is titled "Since you are a free user, you can only access a maximum of 15 tweets. Please upgrade to a paid user to unlock access to all tweets."
  - Whether that 15 is per run or per query, and its date, is **UNVERIFIED**.
  - **On the Free plan this job is effectively capped at about 15 tweets.**
- **Mock data on empty results.** README "Important Notes": there is "a minimum charge of $X per API call, even if the response contains no results. Thus, we returned N pieces of mock data." Empty queries (e.g. a handle that didn't post this week) can still cost money and return fake items.
  - The shape of the mock items and how to detect them is **UNVERIFIED**. Filter on real `id`/`url`.

---

## 2. apify/instagram-post-scraper

- **Actor ID:** `nH2AHrwxeTRJoN5hX`
- **Default run options:** memory 1024 MB, timeout 20000 s

### Inputs (live schema; `username` is required)

| Field | Type | Enum / default | Notes |
|---|---|---|---|
| `username` | array of strings | required | Usernames, profile URLs, or post URLs. |
| `resultsLimit` | integer | min 1, prefill 20, **no default** | "maximum number of posts you want to scrape **per profile**". Ignored for post URLs. |
| `onlyPostsNewerThan` | string (datepicker) | none | "YYYY-MM-DD or full ISO absolute format or in relative format e.g. 1 days, 2 months". UTC. |
| `skipPinnedPosts` | boolean | default `false` | |
| `dataDetailLevel` | string | `basicData` \| `detailedData`; **default `detailedData`** (prefill `basicData`) | "Please note the Detailed data are paid extra." |

### Example
```json
{
  "username": ["HANDLE_1", "HANDLE_2", "HANDLE_3"],
  "resultsLimit": 5,
  "onlyPostsNewerThan": "2026-09-06",
  "skipPinnedPosts": true,
  "dataDetailLevel": "basicData"
}
```
`"onlyPostsNewerThan": "7 days"` also works, per the description.

**Always send `dataDetailLevel` explicitly.** Over the API the schema default `detailedData` applies, not the UI prefill, and it adds a charge.

### Output fields (dataset schema)
- **Identity and text:** `id`, `shortCode`, `url`, `caption`, `type` (Image/Video/Sidecar), `productType` (feed/clips/igtv), `timestamp` (ISO 8601).
- **Author:** `ownerUsername` (handle), `ownerId`, `ownerFullName`.
- **Engagement:**
  - `likesCount`, `commentsCount`
  - Views: `videoPlayCount`. `videoViewCount` is "Deprecated by Instagram; may be null or stale. Prefer videoPlayCount".
  - Shares: `reshareCount` (may be null). `sharesCount` is "reel scraper only".
- **Other:** `isPinned`, `hashtags`, `mentions`, `taggedUsers`.
- **Comments:** `latestComments[]`, each with `id`, `text`, `ownerUsername`, `timestamp`, `likesCount`, `repliesCount`, `replies[]`.
- **Creator replying:** no flag. Compare `latestComments[].ownerUsername` or `replies[].ownerUsername` to the post's `ownerUsername`.
- **Transcripts:** the `transcript` field is "reel scraper only, when includeTranscript is enabled". **Not available from this actor.**
- Which fields `basicData` omits compared with `detailedData` is **UNVERIFIED**. Check the first test run.

### Pricing
- `post`: FREE **$0.0017, i.e. $1.70/1k. Confirmed.**
- `post-details`: FREE **$0.001 ($1.00/1k) extra**. The event description says "with detailed information". The input description indicates this is what `detailedData` triggers.
  - So the default is **$2.70/1k**, which matches the README's "$2.70 per 1,000 results".
- `minimalMaxTotalChargeUsd` = 0.005.

### Free-plan restrictions
None documented for posts.

---

## 3. apify/instagram-comment-scraper

- **Actor ID:** `SbK00X0JYCPblD2wp`
- **Default run options:** memory 1024 MB, timeout 30000 s

### Inputs (live schema; `directUrls` is required)

| Field | Type | Enum / default | Notes |
|---|---|---|---|
| `directUrls` | array of strings | required | Post or reel URLs, matching `instagram.com/(p\|reel)/...`. |
| `resultsLimit` | integer | min 1, prefill 15, no default | "number of comments you expect to scrape **from each post**". Replies add extra results. |
| `includeNestedComments` | boolean | no default | "**This feature is for paying users only.**" Each reply is a separate result. |

The README FAQ calls this option `includeReplies`, which is a stale name. **Use `includeNestedComments`.**

### Example
```json
{
  "directUrls": ["POST_URL_1", "POST_URL_2"],
  "resultsLimit": 15,
  "includeNestedComments": false
}
```

### Output fields
- **Comment:** `id`, `commentUrl`, `postUrl`, `text`, `timestamp` (ISO 8601), `likesCount`, `repliesCount`, `replies[]`.
- **Author:** `ownerUsername` (handle), `owner.id`, `owner.username`, `owner.is_verified`.
- **Parent:** `parentCommentUrl` (for replies).
- **Errors:** `error`, `errorDescription`.
- **Creator replying:** no flag. Compare `ownerUsername` to the post owner (take it from the post scraper's `ownerUsername`).

### Pricing
- `comment`: FREE **$0.0026, i.e. $2.60/1k. Confirmed.** (README stale: $2.30.)
- `minimalMaxTotalChargeUsd` = 0.0026.

### Free-plan restrictions
- **Max 20 comments per post for free users.** The Apify Instagram changelog (2024-11-08) says: "Restored Instagram Comments Scraper. Free users are now limited to maximum 20 results per post. No limit for paying users."
  - Whether that is still enforced in 2026 is **UNVERIFIED**. Keep `resultsLimit` at or below 20 on the Free plan.
- Replies (`includeNestedComments`) are **not available on the Free plan**.

---

## 4. harvestapi/linkedin-profile-posts

- **Actor ID:** `A3cAPGpwBEG8RJwse`
- **Default run options:** memory 256 MB, timeout 4000 s, maxItems null, maxTotalChargeUsd null.

### Inputs (live schema; no required fields)

| Field | Type | Enum / default | Notes |
|---|---|---|---|
| `targetUrls` | array of strings | prefill only | Profile or company URLs (post URLs also accepted). |
| `maxPosts` | integer | prefill 5, no schema default ("Default is 10") | Per profile or company. **`0` = scrape all posts. Never send 0.** |
| `postedLimit` | string | `any` \| `1h` \| `24h` \| `week` \| `month` \| `3months` \| `6months` \| `year` | |
| `postedLimitDate` | string (datepicker) | none | "Scrape posts from now up to and including this date". |
| `includeQuotePosts` | boolean | default `true` | |
| `includeReposts` | boolean | default `true` | |
| `scrapeReactions` | boolean | default `false` | Reactions are charged. |
| `maxReactions` | integer | prefill 5 | |
| `postNestedReactions` | boolean | prefill false | |
| `scrapeComments` | boolean | default `false` | "Comments will be charged as a separate post and pushed into the dataset. Each post will also contain a nested list of its own comments." |
| `maxComments` | integer | prefill 5 ("Default is 5") | Per post. **`0` = all. Never send 0.** |
| `commentsPostedLimit` | string | `any` \| `1h` \| `24h` \| `week` \| `month` | |
| `postNestedComments` | boolean | prefill false | Nest comments inside post items. Risk of hitting item size limits. |
| `contextCountry` | string | `any` \| `US` \| `GB` \| `DE` \| `FR` | |

### Example: posts only
```json
{
  "targetUrls": ["https://www.linkedin.com/in/PROFILE_ID_1/", "https://www.linkedin.com/in/PROFILE_ID_2/"],
  "maxPosts": 5,
  "postedLimit": "week",
  "includeQuotePosts": true,
  "includeReposts": true,
  "scrapeReactions": false,
  "scrapeComments": false
}
```

### Example: posts plus comments in the same run (supported)
Use the same input with:
```json
  "scrapeComments": true,
  "maxComments": 10,
  "commentsPostedLimit": "any",
  "postNestedComments": false
```

### Output fields (README sample; this actor has no dataset schema)
- **Post:**
  - `type` (`"post"`), `id`, `linkedinUrl`, `content`
  - `author.publicIdentifier` (handle), `author.name`, `author.linkedinUrl`, `author.type`
  - `postedAt.timestamp` (ms), `postedAt.date` (ISO)
  - `engagement.likes`, `engagement.comments`, `engagement.shares`, `engagement.reactions[]` (`type`, `count`)
  - `socialContent.shareUrl`
- **Views:** no views count in the sample. Only the flag `socialContent.hideViewsCount`. **Treat views as UNAVAILABLE.**
- **Comments** (the nested `comments[]` in the sample; same shape as actor 5):
  - `id`, `linkedinUrl`, `commentary`, `createdAt` (ISO), `createdAtTimestamp`, `numComments`, `postId`, `pinned`, `edited`
  - `actor.name`, `actor.linkedinUrl`, `actor.position`, **`actor.author` (boolean)**
- **Creator replying:** `actor.author: true` very likely means the commenter is the post author. The exact semantics are **UNVERIFIED**.
- **Separate comment items:** whether they carry `type: "comment"` is **UNVERIFIED**. README: comments are "pushed into the dataset".
- **Reposts:** repost/quote-specific fields are **UNVERIFIED**.
- **Subtitles/transcripts:** none. `document.transcribedDocumentUrl` exists for document posts only.

### Pricing (FREE tier)
| Event | Price |
|---|---|
| `post` | $0.002 (**$2.00/1k, confirmed**) |
| `comment` | $0.002 ($2.00/1k) |
| `reaction` | $0.002 |
| `no-result` | $0.001, "Charged for scraping post pages that don't contain posts". Profiles with no posts this week may cost $0.001 each (**UNVERIFIED** exactly when). |
| `apify-actor-start` | $0.00005 per GB of memory, min one event |

`minimalMaxTotalChargeUsd` = 0.002.

### Free-plan restrictions
None documented.

---

## 5. harvestapi/linkedin-post-comments

- **Actor ID:** `ZI6ykbLlGS3APaPE8`
- **Default run options:** memory 256 MB, timeout 4000 s.

### Inputs (live schema; no required fields)

| Field | Type | Enum / default | Notes |
|---|---|---|---|
| `posts` | array of strings | prefill only | Post URLs or post-comment URLs. The schema description "Queries to search LinkedIn profiles by name" is a copy-paste error. |
| `maxItems` | integer | prefill 10, no default | "Maximum number of comments to scrape per each post". README: "If you set to 0, it will scrape all available pages or up to 100 pages". **Never 0.** This body field is not the API query param. |
| `postedLimit` | string | `any` \| `24h` \| `week` \| `month` \| `3months` \| `6months` \| `year` | |
| `scrapeReplies` | boolean | prefill false | See the replies section below. |
| `profileScraperMode` | string | `short` \| `main`; default `short` | `short` = no charge; `main` = $0.002 per profile. |

### How replies work (README)
- For a **post URL**, the actor collects "up to 5 replies to comments". These are "nested inside comments, so they won't be counted as separate results".
- For a **post-comment URL**, turning on `scrapeReplies` makes replies "counted as separate results".
- Whether `scrapeReplies: true` also expands all replies (as charged items) for plain post URLs is **UNVERIFIED**.
- The field name of the nested replies array is **UNVERIFIED** (the README sample has none).

### Example: comments with the default up-to-5 nested replies
```json
{
  "posts": ["POST_URL_1", "POST_URL_2"],
  "maxItems": 10,
  "postedLimit": "any",
  "scrapeReplies": false,
  "profileScraperMode": "short"
}
```
Set `"scrapeReplies": true` to get replies as separate charged items. Test on one post first.

### Output fields (README sample)
- **Comment:** `type` (`"comment"`), `id`, `linkedinUrl`, `commentary` (text), `createdAt` (ISO), `createdAtTimestamp` (ms), `postId`, `pinned`, `contributed`, `edited`.
- **Counts:** `numComments` (reply count), `numShares`, `numImpressions` (often null), `reactionTypeCounts[]` (`type`, `count`). Likes = sum of the counts, or the `LIKE` entry.
- **Author:** `actor.id`, `actor.name`, `actor.linkedinUrl` (handle is the URL slug), `actor.position`.
- **Creator replying:** `actor.author` (boolean). Likely true when the commenter is the post author; **UNVERIFIED**.
- **Parent/reply id for nested replies:** **UNVERIFIED**.

### Pricing
- `post-comment`: FREE **$0.002, i.e. $2.00/1k. Confirmed.**
- Only relevant if `profileScraperMode` is changed: `main-profile` $0.002, `full-profile` $0.004, `full-profile-with-email` $0.01.
- No start event. `minimalMaxTotalChargeUsd` = 0.01.

### Free-plan restrictions
None documented.

---

## 6. streamers/youtube-scraper

- **Actor ID:** `h7sDV53CddomktSi5`
- **Default run options:** memory 1024 MB, timeout 604800 s

### Inputs (live schema; no required fields)

| Field | Type | Enum / default | Notes |
|---|---|---|---|
| `startUrls` | array (requestListSources) | default `[]` | `[{"url": "..."}]`: video, channel, playlist, or search URLs. |
| `maxResults` | integer | default `0`, max 999999 | "If you scrape a channel, acts as a limit for regular videos." Whether that is per channel or total is **UNVERIFIED**. |
| `maxResultsShorts` | integer | default `0` | |
| `maxResultStreams` | integer | default `0` | |
| `transcriptionAndSubtitle` | string, nullable | `NONE` \| `ALWAYS_SUBTITLES` \| `TRANSCRIPTION_AS_FALLBACK` \| `ALWAYS_TRANSCRIBE`; default `NONE` | `ALWAYS_SUBTITLES` = "Only download subtitles (when present on the video)". This is the free option. The other two are paid speech-to-text. The old `downloadSubtitles` is deprecated. |
| `subtitlesLanguage` | string | `any`, `en`, `de`, `es`, `fr`, `it`, `ja`, `ko`, `nl`, `pt`, `ru`; default `en` | |
| `subtitlesFormat` | string | `srt` \| `vtt` \| `xml` \| `plaintext`; default `srt` | |
| `oldestPostDate` | string (datepicker) | none | "Date range (applicable only to scraping by channels URL) **($)**". Absolute date or relative, e.g. "7 days". |
| `sortVideosBy` | string | `NEWEST` \| `POPULAR` \| `OLDEST` | Channel-page sort. |
| `searchQueries`, `sortingOrder`, `dateFilter` | | | `dateFilter` is `hour`/`today`/`week`/`month`/`year`. Search mode only; not needed here. |
| `aiVideoDescription`, `aiVideoSummary` | boolean | default `false` | Paid. Keep false. |
| `saveSubsToKVS`, `preferAutoGeneratedSubtitles` | boolean (hidden) | none | |

### Example
```json
{
  "startUrls": [{"url": "https://www.youtube.com/@CHANNEL_HANDLE_1/videos"}, {"url": "https://www.youtube.com/@CHANNEL_HANDLE_2/videos"}],
  "maxResults": 5,
  "maxResultsShorts": 0,
  "maxResultStreams": 0,
  "sortVideosBy": "NEWEST",
  "oldestPostDate": "2026-09-06",
  "transcriptionAndSubtitle": "ALWAYS_SUBTITLES",
  "subtitlesLanguage": "en",
  "subtitlesFormat": "plaintext",
  "aiVideoDescription": false,
  "aiVideoSummary": false
}
```
To save $1.30/1k: drop `oldestPostDate`, keep `sortVideosBy: NEWEST` plus a small `maxResults`, and filter by `date` client-side.

### Output fields (dataset schema)
- **Video:** `id`, `url`, `title`, `text` (description), `duration`, `type`.
- **Channel:** `channelUsername` (@handle), `channelName`, `channelUrl`, `channelId`.
- **Date:** `date`, "The publish date of the video".
  - The format varies: README examples show `"2021-12-21"`, with time when available, **and relative strings like `"10 months ago"`**.
  - Changelog: "Will not output time in `date` if the date on the page contained no specific time". Normalize defensively.
- **Engagement:** `viewCount`, `likes`, `commentsCount`. **No shares field.**
- **Subtitles:** in the dataset item as `subtitles[]` (`srtUrl`, `type` e.g. `auto_generated`, `language`, `srt` = subtitle content).
  - Whether the content key stays `srt` when `subtitlesFormat` is `plaintext` is **UNVERIFIED**.
- **Paid transcripts:** `transcriptionUrl` (KV store link). Not used here.
- **Errors:** `error` codes include `CHANNEL_HAS_NO_VIDEOS`, `DATE_FILTER_TOO_STRICT`, `NO_RESULTS`.

### Pricing (FREE tier)
| Event | Price |
|---|---|
| `result` (video) | $0.004, **$4.00/1k (confirmed; README stale says $5)** |
| `date-filter` | **+$0.0013 per video ($1.30/1k) when `oldestPostDate` is used on channels.** So about $5.30/1k with the 7-day filter. |
| `transcribeMinute` | $0.048/min (not used) |
| `ai-video-description` | $0.015/min (not used) |
| `ai-video-summary` | $0.015/min (not used) |

Existing subtitles (`ALWAYS_SUBTITLES`) have no charge event. `minimalMaxTotalChargeUsd` is null.

### Free-plan restrictions
None documented.

---

## 7. streamers/youtube-comments-scraper

- **Actor ID:** `p7UMdpQnjKmmpR21D`
- **Default run options:** memory 1024 MB, timeout 604800 s

### Inputs (live schema; `startUrls` is required)

| Field | Type | Enum / default | Notes |
|---|---|---|---|
| `startUrls` | array (requestListSources) | required | `[{"url": "https://www.youtube.com/watch?v=..."}]` |
| `maxComments` | integer | **default `1`**, min 1, prefill 10 | "Limit the number of comments you want to scrape **per video**." Always send it. Whether replies count toward it is **UNVERIFIED**. |
| `sortCommentsBy` | string | `TOP_COMMENTS` \| `NEWEST_FIRST`; **default `NEWEST_FIRST`** | The changelog mentions `commentsSortBy`; the live schema name is `sortCommentsBy`. |
| `oldestCommentDate` | string (datepicker) | none | Only comments on or after this date. |

### Example
```json
{
  "startUrls": [{"url": "https://www.youtube.com/watch?v=VIDEO_ID_1"}, {"url": "https://www.youtube.com/watch?v=VIDEO_ID_2"}],
  "maxComments": 20,
  "sortCommentsBy": "TOP_COMMENTS"
}
```

### Output fields (dataset schema)
- **Comment:** `cid` (comment id), `comment` (text), `author` (@handle / display name), `voteCount` (likes), `replyCount`.
- **Reply linkage:** `type` (`comment` \| `reply`), `replyToCid` (parent id, null for top level).
- **Creator flags:** **`authorIsChannelOwner`** (creator replied) and **`hasCreatorHeart`**.
- **Video context:** `videoId`, `pageUrl`, `commentsCount` (video total), `title`.
- **Timestamp problem:** the only time field is `publishedTimeText`, which is **relative only** ("2 days ago"). There is **no absolute timestamp**. Convert approximately.

### Pricing
- `result`: FREE **$0.002, i.e. $2.00/1k. Confirmed.**
- `minimalMaxTotalChargeUsd` = **0.50**, so pass `maxTotalChargeUsd` of at least 0.5.

### Free-plan restrictions
None documented.

---

## 8. clockworks/tiktok-scraper

- **Actor ID:** `GdWCkxBtKWOsKjdch`
- **Default run options:** memory 4096 MB, timeout 0

### Inputs (live schema; no required fields)

| Field | Type | Enum / default | Notes |
|---|---|---|---|
| `profiles` | array of strings | none | Usernames or user IDs. |
| `resultsPerPage` | integer | **default `1`**, min 1, prefill 100 | "number of tiktoks you want to scrape **per hashtag, profile, or search query**". |
| `profileScrapeSections` | array of enum | `videos` \| `reposts` \| `stories`; default `["videos"]` | |
| `profileSorting` | string | `latest` \| `popular` \| `oldest`; default `latest` | "Date filters only work with Latest and Oldest". |
| `excludePinnedPosts` | boolean | default `false` | |
| `oldestPostDateUnified` | string (datepicker) | none | "**Optional charged filter.**" Absolute date, or days as a number ("Putting `1` will get you only today's posts"). |
| `newestPostDate` | string (datepicker) | none | Charged filter. |
| `downloadSubtitlesOptions` | string | `NEVER_DOWNLOAD_SUBTITLES` \| `DOWNLOAD_SUBTITLES` \| `DOWNLOAD_AND_TRANSCRIBE_VIDEOS_WITHOUT_SUBTITLES` \| `TRANSCRIBE_ALL_VIDEOS`; default `NEVER_DOWNLOAD_SUBTITLES` | `DOWNLOAD_SUBTITLES` = "only when present on the video". The two transcribe options are paid. The README's `shouldDownloadSubtitles` is a stale name. |
| `commentsPerPost` | integer | prefill 0, min 0 | "💬 TikTok comments ($)". The input description says "The link to the dataset will be under a field commentsDatasetURL in the output." |
| `topLevelCommentsPerPost` | integer | prefill 0 | |
| `maxRepliesPerComment` | integer | prefill 0 | "Successful extraction of all desired replies is currently not guaranteed." |
| `shouldDownloadVideos`, `shouldDownloadCovers`, `shouldDownloadSlideshowImages`, `shouldDownloadAvatars`, `shouldDownloadMusicCovers` | boolean | default `false` | Video download is charged. |
| `aiVideoDescription`, `aiVideoSummary` | boolean | default `false` | Charged. |
| `proxyCountryCode` | string | country codes; default `None` | Anything else is charged. |
| `maxFollowersPerProfile`, `maxFollowingPerProfile` | integer | prefill 0 | Charged. |
| `hashtags`, `searchQueries`, `searchSection`, `postURLs`, `videoSearchSorting`, `videoSearchDateFilter`, `mostDiggs`, `leastDiggs` | | | Not used here. |

### Example: videos plus subtitles, 7 days, max 5 per profile
```json
{
  "profiles": ["HANDLE_1", "HANDLE_2", "HANDLE_3"],
  "profileScrapeSections": ["videos"],
  "profileSorting": "latest",
  "resultsPerPage": 5,
  "excludePinnedPosts": true,
  "oldestPostDateUnified": "2026-09-06",
  "downloadSubtitlesOptions": "DOWNLOAD_SUBTITLES",
  "commentsPerPost": 0,
  "maxRepliesPerComment": 0,
  "shouldDownloadVideos": false,
  "shouldDownloadCovers": false,
  "proxyCountryCode": "None"
}
```

### Comments in the same run: supported, but charged
Changelog: "You can now scrape for comments in the main scraper". To include them, set `"commentsPerPost": 10, "maxRepliesPerComment": 0` (or N).

**Cost:** event `comment-dataset-item` = FREE **$0.00125 per comment ($1.25/1k)**. This is the same price as the dedicated comments actor, charged on top of the video results.

**Where comments land:**
- The schema has both `comments[]` ("Comments collected inline for this video, if comment collection was enabled") and `commentsDatasetUrl` ("URL to the dataset containing comments... if collected separately").
- Which one is populated is **UNVERIFIED**, so handle both.
- A separate dataset **is not returned by run-sync-get-dataset-items**. Fetch it with a second GET.

### Output fields (dataset schema)
- **Video:** `id`, `webVideoUrl`, `text` (caption), `createTimeISO` (ISO), `isPinned`, `isSponsored`.
- **Author:** `authorMeta.name` (handle), `authorMeta.id`, `authorMeta.nickName`, `authorMeta.verified`.
- **Engagement:** `diggCount` (likes), `commentCount`, `shareCount`, `repostCount`, `collectCount`, `playCount` (views).
- **Subtitles:** in `videoMeta.subtitleLinks[]` (`language`, `downloadLink`, `tiktokLink`, `source`, `version`). These are links; the subtitle text requires an extra GET (host **UNVERIFIED**).
- **Paid transcripts:** `videoMeta.transcriptionLink`.
- **Inline comments:** `comments[]` items have `cid`, `text`, `createTimeISO`, `diggCount`, `replyCommentTotal`, `uniqueId`, `repliesToId`, `likedByAuthor`, `pinnedByAuthor`.
- **Errors:** `error`/`errorCode` such as `FILTER_NO_PASS`, `PROFILE_EMPTY`.

### Pricing (FREE tier)
| Event | Price |
|---|---|
| `result` | $0.0037, **$3.70/1k (confirmed)** |
| `filter-applied` (date filter) | **+$0.0013 per result ($1.30/1k) when `oldestPostDateUnified` or `newestPostDate` is used**. So about $5.00/1k with the 7-day filter. |
| `actor-start` | **$0.001 flat per run** |
| `comment-dataset-item` | $0.00125 ($1.25/1k) |
| `transcription-minute` | $0.048/min |
| `video-download`, `scrape-as-in-country`, `popularity-filter-applied`, `mobile-filter-sorting-applied` | $0.0013 each |
| `follower-dataset-item` | $0.004 |
| AI description / summary | $0.0013 per video-second |

Existing subtitles (`DOWNLOAD_SUBTITLES`) have no event. `minimalMaxTotalChargeUsd` = **0.50**.

### Free-plan restrictions
None documented.

---

## 9. clockworks/tiktok-comments-scraper

- **Actor ID:** `BDec00yAmCm1QbMEI`
- **Default run options:** memory 4096 MB, timeout 604800 s

### Inputs (live schema; no required fields)

| Field | Type | Enum / default | Notes |
|---|---|---|---|
| `postURLs` | array of strings | prefill only | Video URLs. |
| `commentsPerPost` | integer | prefill 100, min 1, no default | "number of comments extracted from every result". Whether this includes replies is **UNVERIFIED**. |
| `topLevelCommentsPerPost` | integer | min 1 | Non-reply cap per post. |
| `maxRepliesPerComment` | integer | prefill 0, min 0 | |
| `profiles`, `resultsPerPage`, `profileScrapeSections`, `profileSorting`, `oldestPostDateUnified`, `newestPostDate`, `excludePinnedPosts` | | | Profile mode. Not used here. |

### Example
```json
{
  "postURLs": ["https://www.tiktok.com/@HANDLE/video/VIDEO_ID_1", "https://www.tiktok.com/@HANDLE/video/VIDEO_ID_2"],
  "commentsPerPost": 20,
  "maxRepliesPerComment": 0
}
```

### Output fields (dataset schema)
- **Comment:** `cid` (id), `text`, `createTimeISO` (ISO), `createTime` (unix s), `diggCount` (likes), `replyCommentTotal`.
- **Author:** `uniqueId` (handle), `uid`.
- **Parent/reply:** `repliesToId`.
- **Creator flags:** **`likedByAuthor`** and **`pinnedByAuthor`**.
- **Video context:** `videoWebUrl`, `submittedVideoUrl`, `input`.
- **Creator replying:** no dedicated flag. Compare `uniqueId` to the `@handle` in `videoWebUrl`.

### Pricing
- `result`: FREE **$0.00125, i.e. $1.25/1k. Confirmed.** (README stale: "$5 to scrape 1,000".)
- No start event. `minimalMaxTotalChargeUsd` is null.

### Free-plan restrictions
None documented.

---

## 10. Reddit: harshmaur/reddit-scraper vs automation-lab/reddit-scraper

### Comparison for this job (top of past week, 3 subreddits, N posts per sub, M comments per post, comments by top)

| Need | automation-lab/reddit-scraper | harshmaur/reddit-scraper |
|---|---|---|
| Top of week | `sort: "top"` + `timeFilter: "week"`. **Explicit schema enums.** | Encoded in the URL: `startUrls: [{"url": ".../r/SUB/top/?t=week"}]` (README example). `searchSort`/`searchTime` apply only to keyword search, not Direct URLs. |
| N posts **per subreddit** | `maxPostsPerSource`, "per subreddit, search, or user profile". **Verified.** | `maxPostsCount`, "Maximum number of posts to save across all search results, subreddit pages, and user profiles". A **total**, not per sub. Per-URL behaviour is **UNVERIFIED**. |
| M comments per post | `includeComments` + `maxCommentsPerPost` (default 100) + `commentDepth` (default 3, 1..10). | `crawlCommentsPerPost` + `maxCommentsPerPost` (default 200). |
| Comments sorted by top | **No input. UNVERIFIED.** Client-side sort is unreliable because scores may be 0. | **No input. UNVERIFIED.** Client-side sort by `score` works because scores are real. |
| Data-quality caveat | README: "`score`, `upvoteRatio`, and comment scores may be `0`/missing when Reddit does not expose vote data on public RSS/recovery pages". | Full vote fields. Default proxy is RESIDENTIAL. |

**Pick: `automation-lab/reddit-scraper`.** Every input the job needs exists as a named schema field. (Its README example shows `score: 0`.)

**Risk:** "top" ranking of comments, and any score-based normalization, may be impossible if scores come back 0. If they do, switch to harshmaur, where you'd filter to N per sub and sort comments client-side.

### automation-lab/reddit-scraper
- **Actor ID:** `aYMxR9AqRjxmgzcwB`
- **Default run options:** memory 256 MB, **timeout 300 s** (raise via `?timeout=` if needed).

**Inputs (live schema):**

| Field | Type | Enum / default | Notes |
|---|---|---|---|
| `urls` | array or string | prefill | Subreddit, post, user, or search URLs; `r/name` also accepted. |
| `sort` | string | `hot` \| `new` \| `top` \| `rising` \| `relevance`; **default `hot`** | |
| `timeFilter` | string | `hour` \| `day` \| `week` \| `month` \| `year` \| `all`; default `week` | Used with `top`/`relevance`. |
| `maxPostsPerSource` | integer | default 100, min 0 | **0 = unlimited. Never 0.** |
| `includeComments` | boolean | default false | |
| `maxCommentsPerPost` | integer | default 100, min 1 | |
| `commentDepth` | integer | default 3, 1..10 | Whether 1 means top-level only is **UNVERIFIED**. |
| `deduplicatePosts` | boolean | default true | |
| `outputFormat` | string | `default` \| `jsonl-finetune` \| `rag-markdown`; default `default` | |
| `filterKeywords`, `filterKeywordMode`, `searchQuery`, `searchSubreddit`, `commentContextMode`, `mcp*` | | | Not used here. |

**Example:**
```json
{
  "urls": ["https://www.reddit.com/r/SUBREDDIT_1/", "https://www.reddit.com/r/SUBREDDIT_2/", "https://www.reddit.com/r/SUBREDDIT_3/"],
  "sort": "top",
  "timeFilter": "week",
  "maxPostsPerSource": 5,
  "includeComments": true,
  "maxCommentsPerPost": 10,
  "commentDepth": 1,
  "deduplicatePosts": true,
  "outputFormat": "default"
}
```

**Output fields (README):**
- **Post:** `type` (`post`), `id`, `title`, `author`, `subreddit`, `score`\*, `upvoteRatio`\*, `numComments`, `createdAt` (ISO), `url`, `permalink`, `selfText`, `link`, `linkFlairText`, `warnings[]`.
- **Comment:** `type` (`comment`), `id`, `postId`, `postTitle`, `author`, `body`, `score`\*, `createdAt`, `permalink`, `depth`, `parentId` (`t3_` post / `t1_` comment), `replies` (count).
- **Creator replying:** **`isSubmitter`** (commenter is the OP).
- \*Best-effort; may be 0.

**Pricing (FREE tier):**
- `start`: $0.003 per run
- `post`: $0.00115 ($1.15/1k)
- `comment`: $0.000575 ($0.575/1k)
- `minimalMaxTotalChargeUsd` not set. The README advises a max-charge cap because the actor "only checks this when charging events".

**Free-plan restrictions:** none documented.

### harshmaur/reddit-scraper (fallback)
- **Actor ID:** `9sHOY9RzPYGjmTHo8`
- **Default run options:** memory 512 MB, timeout 12780 s, `maxTotalChargeUsd: 0` in defaults (meaning **UNVERIFIED**).

**Key inputs (live schema):**
- `startUrls` (requestListSources)
- `subredditUrls` (full-subreddit scrape; more requests)
- `maxPostsCount` (default 50, 0..50000)
- `crawlCommentsPerPost` (default false)
- `maxCommentsPerPost` (default 200)
- `maxCommentsCount` (default 400; keyword comment search only)
- `includeNSFW` (default false)
- `fastMode` (default true)
- `postedAfter` / `postedBefore` / `commentedAfter` / `commentedBefore` (datepicker; setting `postedAfter` forces sort=new)
- `searchTerms`, `searchSort` (`""`, `relevance`, `hot`, `top`, `new`, `comments`), `searchTime` (`all`, `hour`, `day`, `week`, `month`, `year`)
- `aiAnalysis` (paid; ignored on free plans)
- `proxy` (default `{"useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"]}`)

**Example:**
```json
{
  "startUrls": [{"url": "https://www.reddit.com/r/SUBREDDIT_1/top/?t=week"}, {"url": "https://www.reddit.com/r/SUBREDDIT_2/top/?t=week"}, {"url": "https://www.reddit.com/r/SUBREDDIT_3/top/?t=week"}],
  "maxPostsCount": 15,
  "crawlCommentsPerPost": true,
  "maxCommentsPerPost": 10,
  "includeNSFW": false,
  "aiAnalysis": false,
  "proxy": {"useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"]}
}
```

**Output fields:** split items by `dataType` (`post` \| `comment` \| `community`). All timestamps are ISO UTC.
- **Post:** `id` (`t3_…`), `parsedId`, `url`/`postUrl`, `title`, `body`, `authorName`, `parsedCommunityName`, `createdAt`, `upVotes`/`score`, `upvoteRatio`, `commentsCount`, `numCrossposts`.
- **Comment:** `id`, `url`, `body`, `authorName`, `commentCreatedAt`, `score`/`commentUpVotes`, `postId`, `parentId` (`t3_`/`t1_`), `parentKind`, `depth`, **`isSubmitter`** (OP flag), `distinguished`.

**Pricing (FREE tier):**
- `result`: $0.002 ($2.00/1k)
- `init`: $0.02 "per GB of memory" (512 MB default; minimum-one-event is **UNVERIFIED**)
- AI add-ons: $0.0005 / $0.0001

**Free-plan notes:**
- "Free Apify plans search the first 40 keywords per run" (not relevant here).
- AI add-ons are ignored on free plans.
- Whether RESIDENTIAL proxy use on a PPE actor costs a Free-plan user anything is **UNVERIFIED**.

---

## 11. Price check summary (FREE tier, per 1,000)

| Actor | Your figure | Verified | Correction / add-ons |
|---|---|---|---|
| X tweets | $0.25 | **$0.25** | Free users capped at about 15 tweets; mock items are charged on empty queries. |
| IG posts | $1.70 | **$1.70 only with `dataDetailLevel: "basicData"`** | Default `detailedData` adds $1.00, total $2.70. |
| IG comments | $2.60 | **$2.60** | Free users max 20 per post (2024 changelog); replies need a paid plan. |
| LinkedIn posts | $2.00 | **$2.00** | + comments $2.00, + `no-result` $1.00, + start $0.00005/GB. |
| LinkedIn comments | $2.00 | **$2.00** | Profile enrichment is extra if `profileScraperMode` ≠ `short`. |
| YouTube videos | ~$4 | **$4.00** | **+$1.30 with `oldestPostDate`** (about $5.30). Existing subtitles are free. |
| YouTube comments | $2.00 | **$2.00** | Min max-charge $0.50. |
| TikTok results | $3.70 | **$3.70** | **+$1.30 with date filter**, + $0.001 start per run, + comments $1.25/1k if `commentsPerPost` > 0. Min max-charge $0.50. |
| TikTok comments | $1.25 | **$1.25** | none |
| Reddit (automation-lab) | n/a | $1.15 posts / $0.575 comments | + $0.003 start per run |

### Rough cost of the example inputs
Assumes 3 inputs each and full limits hit:

| Actor | Estimate |
|---|---|
| X | about $0.01 (Free cap ~15 tweets) |
| IG posts (15, basic) | $0.026 |
| IG comments (45) | $0.12 |
| LinkedIn posts (15) | $0.03, or +$0.30 with 10 comments per post |
| LinkedIn comments (30) | $0.06 |
| YouTube (15 with date filter) | $0.08 |
| YouTube comments (60) | $0.12 |
| TikTok (15 with date filter + start) | $0.08, or +$0.19 with 10 comments per post |
| TikTok comments (60) | $0.075 |
| Reddit (15 posts + 150 comments + start) | $0.11 |
| **Total** | **about $0.7 to $1.2**, within the $5 Free credit |

**Per-call `maxTotalChargeUsd`:**
- Use the actor's floor where one exists: **0.50** for YouTube comments and TikTok scraper, 0.01 for LinkedIn comments.
- Otherwise use about 0.25.
