// What the public landing page shows, derived from one published story so its numbers are real.
// Everything here is computed by code from the story's stats; nothing is written by hand.
import { PLATFORM_NAMES, stripCites, truncate } from './format.js';
import { PLATFORMS } from './pricing.js';
import { MIN_COMMENTS_FOR_PCT } from './stories.js';

// A source line safe for a public page: commenters stay anonymous, creators are public figures.
export const publicWho = (who = '') => who.replace(/comment by [^·]+/, 'comment');

// The story the page is built around: a top story that several platforms covered.
export function pickSpecimen(stories) {
  return (
    stories.find((s) => !s.whyNotTop && (s.platform_strip?.length ?? 0) >= 3) ??
    stories.find((s) => (s.platform_strip?.length ?? 0) >= 2) ??
    stories[0] ??
    null
  );
}

// One panel per platform for the folded sheet: the platform's take, its clearest counted stance
// and one quote. Platforms with no posts are shown as quiet, which is a signal in itself.
export function sheetPanels(story) {
  const lens = story?.platform_takes?.platforms ?? [];
  const strip = story?.feed_edit?.platform_strip ?? story?.platform_strip ?? [];
  const angles = story?.narrative?.angles ?? [];
  const hidden = story?.checks?.hidden_quotes ?? [];
  const sources = story?.sources ?? {};
  return PLATFORMS.map((platform) => {
    const name = PLATFORM_NAMES[platform];
    const take = lens.find((p) => p.platform === platform);
    const gist = strip.find((s) => s.platform === platform)?.gist ?? null;
    const nums = story?.platforms?.[platform];
    if (!take && !gist && !nums?.posts) return { platform, name, quiet: true };

    const counted = (nums?.angleAgreement ?? [])
      .filter((a) => a.agreePct != null && a.comments >= MIN_COMMENTS_FOR_PCT)
      .sort((a, b) => b.comments - a.comments)[0];
    const quoteSource = sources[take?.quote?.source_id];
    const showQuote = Boolean(take?.quote?.text) && !hidden.includes(`lens:${platform}`);
    return {
      platform,
      name,
      quiet: false,
      take: take?.take ?? gist ?? '',
      stand: counted ? { title: angles[counted.angleIndex]?.title ?? 'This argument', agreePct: counted.agreePct, comments: counted.comments } : null,
      quote: showQuote ? truncate(take.quote.text, 100) : null,
      quoteWho: quoteSource && /· comment by /.test(quoteSource.who) ? `Comment on ${name}` : `Creator post on ${name}`,
      posts: nums?.posts ?? 0,
      comments: nums?.commentsGrouped ?? 0,
    };
  });
}

// The argument the platforms disagree on most: the widest gap in agreement between two platforms
// that each have enough comments to count. Null when no argument splits them by 20 points.
export function sharpestContrast(story) {
  const angles = story?.narrative?.angles ?? [];
  let best = null;
  for (const reaction of story?.stats?.angle_reactions ?? []) {
    const rows = (reaction.by_platform ?? []).filter((p) => p.agree_pct != null && p.comments >= MIN_COMMENTS_FOR_PCT);
    if (rows.length < 2) continue;
    const hi = rows.reduce((a, b) => (b.agree_pct > a.agree_pct ? b : a));
    const lo = rows.reduce((a, b) => (b.agree_pct < a.agree_pct ? b : a));
    const gap = hi.agree_pct - lo.agree_pct;
    if (!best || gap > best.gap) best = { gap, title: angles[reaction.angle_index]?.title ?? reaction.title ?? '', hi, lo };
  }
  return best && best.gap >= 20 ? best : null;
}

// The opening of the story as published, with each citation resolved to a public description.
export function proofSentences(story, count = 2) {
  const sources = story?.sources ?? {};
  const order = new Map();
  return (story?.written?.narrative ?? []).slice(0, count).map((s) => ({
    text: stripCites(s.sentence),
    cites: (s.cites ?? []).map((id) => {
      if (!order.has(id)) order.set(id, order.size + 1);
      const source = sources[id];
      return { id, n: order.get(id), who: source ? publicWho(source.who) : 'Source', url: source?.url ?? null, text: source ? truncate(source.text, 90) : '' };
    }),
  }));
}

// What the checks counted for this story, so the page can show real numbers rather than claims.
export function checkSummary(story) {
  const narrative = story?.written?.narrative ?? [];
  const headline = story?.feed_edit?.headline ?? story?.written?.headline ?? '';
  const cites = new Set(narrative.flatMap((s) => s.cites ?? []));
  const quotes = (story?.written?.quotes ?? []).length + (story?.platform_takes?.platforms ?? []).filter((p) => p.quote?.text).length;
  const counted = (story?.stats?.angle_reactions ?? []).filter((r) => r.total?.agree_pct != null && r.total.comments >= MIN_COMMENTS_FOR_PCT).length;
  return {
    pass: Boolean(story?.checks?.pass),
    cites: cites.size,
    quotes,
    counted,
    headlineWords: headline.split(/\s+/).filter(Boolean).length,
    sentences: narrative.length,
  };
}
