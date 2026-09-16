// Checks every citation, quote and number in a written story against the collected posts and
// comments, plus the length limits and the main-character check. Code only; the result is
// story_versions.checks and decides whether a version passed.
export const LIMITS = { feedHeadlineWords: 12, writerHeadlineWords: 16, narrativeSentences: 5, dekWords: 30, takeWords: 14, gistWords: 8 };

export const normalize = (s) =>
  String(s ?? '')
    .normalize('NFKC')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

export const wordCount = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean).length;
const stripCites = (s) => String(s ?? '').replace(/\s*\[[^\]]*\]\s*$/, '');

const NUMBER = /(?<![\w.])\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![\w.])\d+(?:\.\d+)?/g;
const numbersIn = (text) => (String(text ?? '').match(NUMBER) || []).map((n) => Number(n.replace(/,/g, '')));

function collectNumbers(value, into = new Set()) {
  if (typeof value === 'number') {
    into.add(value);
    into.add(Math.round(value));
    into.add(Math.round(value * 10) / 10);
  } else if (Array.isArray(value)) value.forEach((v) => collectNumbers(v, into));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectNumbers(v, into));
  return into;
}

// Lookups over a world (see storybuild.js loadWorld): what an ID is, its platform and its text.
function sourcesOf(world) {
  const { postById, commentById, groupById, claimById } = world;
  const known = (id) => postById.has(id) || commentById.has(id) || groupById.has(id) || claimById.has(id);
  const platformOf = (id) => {
    if (postById.has(id)) return postById.get(id).platform;
    if (commentById.has(id)) return postById.get(commentById.get(id).post_id)?.platform ?? null;
    if (groupById.has(id)) return postById.get(groupById.get(id).post_id)?.platform ?? null;
    if (claimById.has(id)) return postById.get(claimById.get(id).post_id)?.platform ?? null;
    return null;
  };
  const sourceText = (id) => {
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
  };
  return { known, platformOf, sourceText };
}

// Headline, sentence and word limits, per AI step so only the failing step is re-run. A hard
// problem (feed headline over 12 words, narrative over 5 sentences, a missing headline) fails the
// version if the re-run doesn't fix it; a soft one is a warning.
export function lengthProblems({ written, edit, lens }) {
  const out = { writer: [], lens: [], edit: [] };
  const hard = (text) => ({ text, hard: true });
  const soft = (text) => ({ text, hard: false });
  if (written) {
    const sentences = (written.narrative ?? []).length;
    if (!sentences) out.writer.push(hard('narrative: no sentences'));
    else if (sentences > LIMITS.narrativeSentences) out.writer.push(hard(`narrative: ${sentences} sentences, over the ${LIMITS.narrativeSentences}-sentence limit`));
    const words = wordCount(written.headline);
    if (!words) out.writer.push(hard('headline: missing'));
    else if (words > LIMITS.writerHeadlineWords) out.writer.push(soft(`headline: ${words} words, over the ${LIMITS.writerHeadlineWords}-word limit`));
  }
  if (edit) {
    const headline = String(edit.headline ?? '').trim();
    const words = wordCount(headline);
    if (!headline) out.edit.push(hard('feed headline: missing'));
    else if (words > LIMITS.feedHeadlineWords) out.edit.push(hard(`feed headline: ${words} words, over the ${LIMITS.feedHeadlineWords}-word limit`));
    if (/[.;:]$/.test(headline)) out.edit.push(soft('feed headline: ends with punctuation'));
    if (wordCount(edit.dek) > LIMITS.dekWords) out.edit.push(soft(`feed dek: ${wordCount(edit.dek)} words, over the ${LIMITS.dekWords}-word limit`));
  }
  if (lens) {
    for (const p of lens.platforms ?? []) {
      if (wordCount(p.take) > LIMITS.takeWords) out.lens.push(soft(`${p.platform} take: ${wordCount(p.take)} words, over the ${LIMITS.takeWords}-word limit`));
    }
  }
  return out;
}

// Whole-word match: "DeepSeek" matches "DeepSeek" and "DeepSeek V4.1 Flash", never "DeepSeeker".
const words = (s) => normalize(s).replace(/[^\p{L}\p{N}.\-' ]+/gu, ' ').split(' ').filter(Boolean);
export function sameName(a, b) {
  const wa = words(a);
  const wb = words(b);
  if (!wa.length || !wb.length) return false;
  if (wa.join(' ') === wb.join(' ')) return true;
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  const text = ` ${long.join(' ')} `;
  return text.includes(` ${short.join(' ')} `);
}

// The narrative's main character must be one of the story's top claim subjects (claims.about) or
// top entities by salience. `canonical` resolves aliases so "Astra" matches "GPT-6 Astra".
export function mainCharacterProblem({ narrative, world, postIds, ranking, canonical = null, top = 5 }) {
  const name = narrative?.main_character?.name;
  if (!String(name ?? '').trim()) return 'main character: missing';
  const subjects = new Map();
  for (const claim of world.claimById.values()) {
    if (!postIds.includes(claim.post_id) || !claim.about) continue;
    subjects.set(claim.about, (subjects.get(claim.about) ?? 0) + 1);
  }
  const topSubjects = [...subjects.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([s]) => s);
  const topEntities = (ranking ?? []).slice(0, top).map((e) => e.name);
  const candidates = [...topSubjects, ...topEntities];
  const key = canonical ? canonical(name) : null;
  const ok = candidates.some((c) => sameName(c, name) || (key && canonical(c) === key));
  return ok ? null : `main character: "${name}" is not among the top claim subjects (${topSubjects.join(', ') || 'none'}) or entities (${topEntities.join(', ') || 'none'})`;
}

// The citation check from the dry run (verify.mjs) for one story. `lensInput` is what the platform
// lens was given; its per-platform numbers are allowed in the lens text.
export function verifyStory({ storyId = null, world, postIds, narrative, stats, written, lens = null, lensInput = null, edit = null }) {
  const { known, platformOf, sourceText } = sourcesOf(world);
  const errors = [];
  const warnings = [];
  const quoteSources = {};
  const hiddenQuotes = [];
  const allowedNumbers = collectNumbers(stats);
  const storyComments = [...world.commentById.values()].filter((c) => postIds.includes(c.post_id)).map((c) => c.id);

  // Finds where a quote really comes from. A trailing "…" and the partial word before it are ignored.
  // If the quote isn't in its stated source but is in exactly one other post or comment of this story
  // (on the allowed platform), that one becomes the source.
  const locateQuote = (text, statedId, platform) => {
    const core = normalize(String(text ?? '').replace(/\s*\S*(?:…|\.\.\.)\s*$/, ''));
    if (core.length < 12) return { found: false };
    if (known(statedId) && normalize(sourceText(statedId)).includes(core)) return { found: true, id: statedId };
    const hits = [...postIds, ...storyComments].filter((id) => !platform || platformOf(id) === platform).filter((id) => normalize(sourceText(id)).includes(core));
    return hits.length === 1 ? { found: true, id: hits[0], moved: true } : { found: false };
  };

  // Quotes that can't be found word for word are hidden on the page, not shown unverified.
  const checkQuote = (key, label, text, statedId, platform) => {
    const loc = locateQuote(text, statedId, platform);
    if (!loc.found) {
      hiddenQuotes.push(key);
      warnings.push(`${label}: not found word for word in ${statedId} or elsewhere in the story, hidden`);
    } else if (loc.moved) {
      quoteSources[key] = loc.id;
      warnings.push(`${label}: attributed to ${statedId} but found in ${loc.id}, source corrected`);
    }
  };

  const checkNumbers = (where, text, cites) => {
    const citedNumbers = new Set(numbersIn((cites || []).map(sourceText).join(' ')));
    for (const n of numbersIn(text)) {
      if (!allowedNumbers.has(n) && !citedNumbers.has(n)) warnings.push(`${where}: number ${n} is not in the computed stats or its cited sources`);
    }
  };

  // Narrative structure
  (narrative?.beats || []).forEach((b, i) => {
    [...(b.source_post_ids || []), ...(b.source_comment_ids || [])].forEach((id) => {
      if (!known(id)) errors.push(`beat ${i}: unknown source ${id}`);
    });
    if (!(b.source_post_ids || []).length && !(b.source_comment_ids || []).length) errors.push(`beat ${i}: has no source`);
  });
  (narrative?.angles || []).forEach((a, i) => {
    if (!(a.evidence || []).length) errors.push(`angle ${i} "${a.title}": has no evidence`);
    (a.evidence || []).forEach((e) => {
      if (!known(e.source_id)) errors.push(`angle ${i} "${a.title}": unknown evidence ${e.source_id}`);
      const claim = world.claimById.get(e.source_id);
      if (claim?.quote && !normalize(sourceText(claim.post_id)).includes(normalize(claim.quote))) warnings.push(`claim ${e.source_id}: its quote is not verbatim in the post`);
    });
  });
  (narrative?.reactions || []).forEach((r) => {
    if (!world.groupById.has(r.group_id)) errors.push(`reaction: unknown group ${r.group_id}`);
  });

  // Written story
  if (!written) errors.push('written story: missing');
  (written?.narrative || []).forEach((s, i) => {
    if (!(s.cites || []).length) errors.push(`narrative sentence ${i + 1}: no citation`);
    (s.cites || []).forEach((id) => {
      if (!known(id)) errors.push(`narrative sentence ${i + 1}: unknown citation ${id}`);
    });
    checkNumbers(`narrative sentence ${i + 1}`, s.sentence, s.cites);
  });
  (written?.angle_blurbs || []).forEach((b) => {
    (b.cites || []).forEach((id) => {
      if (!known(id)) errors.push(`angle blurb ${b.angle_index}: unknown citation ${id}`);
    });
    checkNumbers(`angle blurb ${b.angle_index}`, b.text, b.cites);
  });
  if (written) checkNumbers('headline', written.headline, postIds);
  (written?.quotes || []).forEach((q, i) => checkQuote(`written:${i}`, `quote ${i + 1}`, q.text, q.source_id, null));
  if (written && (written.beat_lines || []).length !== (narrative?.beats || []).length) {
    warnings.push(`beat_lines has ${(written.beat_lines || []).length} lines for ${(narrative?.beats || []).length} beats`);
  }

  // What each platform is saying
  if (lens) {
    if (lensInput) collectNumbers((lensInput.platforms ?? []).map((p) => p.numbers), allowedNumbers);
    const storyPlatforms = new Set(postIds.map((id) => world.postById.get(id)?.platform));
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

  // Feed headline, dek and platform strip
  if (edit) {
    checkNumbers('feed headline', edit.headline, postIds);
    checkNumbers('feed dek', edit.dek, postIds);
    const cardPlatforms = new Set((lens?.platforms || []).map((p) => p.platform));
    (edit.platform_strip || []).forEach((s) => {
      if (!cardPlatforms.has(s.platform)) errors.push(`feed strip: ${s.platform} has no platform card`);
      if (wordCount(s.gist) > LIMITS.gistWords) warnings.push(`feed strip: ${s.platform} gist is over ${LIMITS.gistWords} words`);
    });
  }

  return { story_id: storyId, pass: errors.length === 0, errors, warnings, quote_sources: quoteSources, hidden_quotes: hiddenQuotes };
}

export { stripCites };
