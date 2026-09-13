// Step 9: checks every citation, quote and number in the written stories.
// Usage: node scripts/verify.mjs [story_id]
import { join } from 'node:path';
import { DATA, loadWorld, readJson, writeJson } from './lib.mjs';

const only = process.argv[2];
const world = loadWorld();
const { postById, commentById, groupById, claimById } = world;
const { stories } = readJson(join(DATA, 'stories.json'));

const normalize = (s) =>
  String(s ?? '')
    .normalize('NFKC')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const known = (id) => postById.has(id) || commentById.has(id) || groupById.has(id) || claimById.has(id);

function platformOf(id) {
  if (postById.has(id)) return postById.get(id).platform;
  if (commentById.has(id)) return commentById.get(id).platform;
  if (groupById.has(id)) return postById.get(groupById.get(id).post_id)?.platform;
  if (claimById.has(id)) return postById.get(claimById.get(id).post_id)?.platform;
  return null;
}

function sourceText(id) {
  if (postById.has(id)) {
    const p = postById.get(id);
    return `${p.text || ''} ${p.transcript || ''}`;
  }
  if (commentById.has(id)) return commentById.get(id).text || '';
  if (claimById.has(id)) {
    const claim = claimById.get(id);
    return `${claim.quote || ''} ${sourceText(claim.post_id)}`;
  }
  if (groupById.has(id)) return (groupById.get(id).comment_ids || []).map((c) => commentById.get(c)?.text || '').join(' ');
  return '';
}

// Finds where a quote really comes from. A trailing "…" and the partial word before it are ignored.
// If the quote isn't in its stated source but is in exactly one other post or comment of this story
// (on the allowed platform), that one becomes the source.
function locateQuote(text, statedId, storyPostIds, platform) {
  const core = normalize(String(text ?? '').replace(/\s*\S*(?:…|\.\.\.)\s*$/, ''));
  if (core.length < 12) return { found: false };
  if (known(statedId) && normalize(sourceText(statedId)).includes(core)) return { found: true, id: statedId };
  const postIds = new Set(storyPostIds);
  const candidates = [...storyPostIds, ...world.comments.filter((c) => postIds.has(c.post_id)).map((c) => c.comment_id)]
    .filter((id) => !platform || platformOf(id) === platform);
  const hits = candidates.filter((id) => normalize(sourceText(id)).includes(core));
  return hits.length === 1 ? { found: true, id: hits[0], moved: true } : { found: false };
}

const NUMBER = /(?<![\w.])\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![\w.])\d+(?:\.\d+)?/g;
const numbersIn = (text) => (String(text).match(NUMBER) || []).map((n) => Number(n.replace(/,/g, '')));

function collectNumbers(value, into = new Set()) {
  if (typeof value === 'number') {
    into.add(value);
    into.add(Math.round(value));
    into.add(Math.round(value * 10) / 10);
  } else if (Array.isArray(value)) value.forEach((v) => collectNumbers(v, into));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectNumbers(v, into));
  return into;
}

let failed = 0;
for (const story of stories) {
  if (only && story.story_id !== only) continue;
  const written = readJson(join(DATA, 'written', `${story.story_id}.json`), null);
  const narrative = readJson(join(DATA, 'narrative', `${story.story_id}.json`), null);
  const stats = readJson(join(DATA, 'stats', `${story.story_id}.json`), null);
  if (!written || !narrative || !stats) {
    console.log(`${story.story_id}: not written yet, skipped`);
    continue;
  }
  const errors = [];
  const warnings = [];
  const quoteSources = {};
  const hiddenQuotes = [];
  const allowedNumbers = collectNumbers(stats);

  // Quotes that can't be found word for word are hidden on the page, not shown unverified.
  const checkQuote = (key, label, text, statedId, platform) => {
    const loc = locateQuote(text, statedId, story.post_ids, platform);
    if (!loc.found) {
      hiddenQuotes.push(key);
      warnings.push(`${label}: not found word for word in ${statedId} or elsewhere in the story, hidden`);
    } else if (loc.moved) {
      quoteSources[key] = loc.id;
      warnings.push(`${label}: attributed to ${statedId} but found in ${loc.id}, source corrected`);
    }
  };

  const checkNumbers = (where, text, cites) => {
    const citedText = (cites || []).map(sourceText).join(' ');
    const citedNumbers = new Set(numbersIn(citedText));
    for (const n of numbersIn(text)) {
      if (!allowedNumbers.has(n) && !citedNumbers.has(n)) warnings.push(`${where}: number ${n} is not in the computed stats or its cited sources`);
    }
  };

  // Narrative structure from step 6
  (narrative.beats || []).forEach((b, i) => {
    [...(b.source_post_ids || []), ...(b.source_comment_ids || [])].forEach((id) => {
      if (!known(id)) errors.push(`beat ${i}: unknown source ${id}`);
    });
    if (!(b.source_post_ids || []).length && !(b.source_comment_ids || []).length) errors.push(`beat ${i}: has no source`);
  });
  (narrative.angles || []).forEach((a, i) => {
    if (!(a.evidence || []).length) errors.push(`angle ${i} "${a.title}": has no evidence`);
    (a.evidence || []).forEach((e) => {
      if (!known(e.source_id)) errors.push(`angle ${i} "${a.title}": unknown evidence ${e.source_id}`);
      const claim = claimById.get(e.source_id);
      if (claim?.quote && !normalize(sourceText(claim.post_id)).includes(normalize(claim.quote))) {
        warnings.push(`claim ${e.source_id}: its quote is not verbatim in the post`);
      }
    });
  });
  (narrative.reactions || []).forEach((r) => {
    if (!groupById.has(r.group_id)) errors.push(`reaction: unknown group ${r.group_id}`);
  });

  // Written story from step 8
  (written.narrative || []).forEach((s, i) => {
    if (!(s.cites || []).length) errors.push(`narrative sentence ${i + 1}: no citation`);
    (s.cites || []).forEach((id) => {
      if (!known(id)) errors.push(`narrative sentence ${i + 1}: unknown citation ${id}`);
    });
    checkNumbers(`narrative sentence ${i + 1}`, s.sentence, s.cites);
  });
  (written.angle_blurbs || []).forEach((b) => {
    (b.cites || []).forEach((id) => {
      if (!known(id)) errors.push(`angle blurb ${b.angle_index}: unknown citation ${id}`);
    });
    checkNumbers(`angle blurb ${b.angle_index}`, b.text, b.cites);
  });
  checkNumbers('headline', written.headline, story.post_ids);
  (written.quotes || []).forEach((q, i) => checkQuote(`written:${i}`, `quote ${i + 1}`, q.text, q.source_id, null));
  if ((written.beat_lines || []).length !== (narrative.beats || []).length) {
    warnings.push(`beat_lines has ${(written.beat_lines || []).length} lines for ${(narrative.beats || []).length} beats`);
  }

  // "What each platform is saying" from step 8b
  const lens = readJson(join(DATA, 'lens', `${story.story_id}.json`), null);
  if (lens) {
    const lensInput = readJson(join(DATA, 'inputs', 'lens', `${story.story_id}.json`), null);
    if (lensInput) collectNumbers(lensInput.platforms.map((p) => p.numbers), allowedNumbers);
    const storyPlatforms = new Set(story.post_ids.map((id) => postById.get(id)?.platform));
    (lens.contrast || []).forEach((s, i) => {
      (s.cites || []).forEach((id) => {
        if (!known(id)) errors.push(`platform contrast ${i + 1}: unknown citation ${id}`);
      });
      checkNumbers(`platform contrast ${i + 1}`, s.sentence, s.cites);
    });
    (lens.platforms || []).forEach((pl) => {
      if (!storyPlatforms.has(pl.platform)) errors.push(`platform card ${pl.platform}: not a platform in this story`);
      for (const part of ['creators_say', 'audience_says']) {
        const block = pl[part];
        if (!block?.text) continue;
        (block.cites || []).forEach((id) => {
          if (!known(id)) errors.push(`${pl.platform} ${part}: unknown citation ${id}`);
          else if (platformOf(id) !== pl.platform) warnings.push(`${pl.platform} ${part}: cites ${id} from ${platformOf(id)}`);
        });
        checkNumbers(`${pl.platform} ${part}`, block.text, block.cites);
      }
      if (pl.quote?.text) checkQuote(`lens:${pl.platform}`, `${pl.platform} quote`, pl.quote.text, pl.quote.source_id, pl.platform);
    });
  }

  // Feed headline, dek and platform strip from step 9
  const edit = readJson(join(DATA, 'edit', `${story.story_id}.json`), null);
  if (edit) {
    const headline = String(edit.headline ?? '').trim();
    const words = headline.split(/\s+/).filter(Boolean).length;
    if (!headline) errors.push('feed headline: missing');
    else if (words > 12) warnings.push(`feed headline: ${words} words, over the 12-word limit`);
    if (/[.;:]$/.test(headline)) warnings.push('feed headline: ends with punctuation');
    checkNumbers('feed headline', headline, story.post_ids);
    checkNumbers('feed dek', edit.dek, story.post_ids);
    const cardPlatforms = new Set((lens?.platforms || []).map((p) => p.platform));
    (edit.platform_strip || []).forEach((s) => {
      if (!cardPlatforms.has(s.platform)) errors.push(`feed strip: ${s.platform} has no platform card`);
    });
  }

  const result = { story_id: story.story_id, pass: errors.length === 0, errors, warnings, quote_sources: quoteSources, hidden_quotes: hiddenQuotes };
  writeJson(join(DATA, 'verify', `${story.story_id}.json`), result);
  if (!result.pass) failed += 1;
  console.log(`${story.story_id}: ${result.pass ? 'PASS' : 'FAIL'} · ${errors.length} errors · ${warnings.length} warnings`);
  errors.forEach((e) => console.log(`  error: ${e}`));
  warnings.slice(0, 8).forEach((w) => console.log(`  warning: ${w}`));
}
process.exitCode = failed ? 1 : 0;
