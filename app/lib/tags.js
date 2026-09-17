// Tags: the kinds of story a watchlist asks for. These are the ready-made ones; a watchlist starts with
// the ones that fit what the workspace said it is, and can edit them, remove them or write its own.
// `rule` is what the grouping AI reads. `minSources` is checked by code for a new story: 1 means one
// post is enough, 2 means two posts from different sources or one post with a lift of 3 or more.
// No imports, so the pipeline, the pages and the browser can all load it.

export const TAG_TEMPLATES = [
  {
    key: 'brand_deals',
    name: 'Brand deals',
    rule: 'A creator promotes, reviews or partners with a brand: sponsored or paid posts, affiliate links and codes, giveaways, product seeding, ambassador deals.',
    minSources: 1,
  },
  {
    key: 'creator_moves',
    name: 'Creator moves',
    rule: 'A creator announces something of their own: a launch, product, event, collaboration, new show or series, milestone, or a change in what they do.',
    minSources: 1,
  },
  {
    key: 'breakouts',
    name: 'Breakouts',
    rule: 'A post doing far better than the creator usually does (lift of 3 or more). The story is what made it work: the hook, the format or the topic.',
    minSources: 1,
  },
  {
    key: 'brand_mentions',
    name: 'Brand mentions',
    rule: 'What creators and their audiences say about a brand or product when it isn’t a paid promotion: praise, complaints, comparisons, reviews. Brands this watchlist follows come first.',
    minSources: 1,
  },
  {
    key: 'trends',
    name: 'Trends',
    rule: 'Several creators on the same theme, format, meme or opinion this week, even with no single event behind it.',
    minSources: 2,
  },
  {
    key: 'news',
    name: 'News',
    rule: 'A specific event, launch, change or controversy that people are discussing this week.',
    minSources: 2,
  },
  {
    key: 'brand_safety',
    name: 'Brand safety',
    rule: 'A creator in a controversy or backlash, an offensive or misleading post, or legal trouble that a brand working with them should know about.',
    minSources: 1,
  },
];

// What a watchlist starts with, by the use case picked in onboarding.
const BY_USE_CASE = {
  agency: ['brand_deals', 'creator_moves', 'breakouts', 'brand_mentions', 'brand_safety'],
  brand: ['brand_mentions', 'brand_deals', 'brand_safety', 'breakouts'],
  media: ['news', 'trends', 'breakouts'],
  exploring: ['news', 'trends', 'breakouts'],
};

export const TAG_LIMITS = { name: 40, rule: 300, perWatchlist: 10 };

export const templateByKey = (key) => TAG_TEMPLATES.find((t) => t.key === key) ?? null;

export function defaultTemplates(useCase) {
  return (BY_USE_CASE[useCase] ?? BY_USE_CASE.exploring).map(templateByKey);
}
