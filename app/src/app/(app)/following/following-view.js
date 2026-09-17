'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { PLATFORM_NAMES, plural } from '../../../../lib/format.js';
import ChannelRing from '../../components/channel-ring.js';
import CreatorFinder from '../../components/creator-finder.js';
import Icon from '../../components/icons.js';
import PlatformMark from '../../components/platform-mark.js';
import { Change, Sparkline, compact } from '../../components/source-numbers.js';
import StoryStrip from '../../components/story-strip.js';
import { followAction, setPausedAction, unfollowAction } from './actions.js';

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'creator', label: 'Creators' },
  { id: 'community', label: 'Subreddits' },
  { id: 'keyword', label: 'Brands & topics' },
  { id: 'quiet', label: 'Quiet' },
];
const COLUMNS = [
  { key: 'name', label: 'Name', className: 'col-name' },
  { key: 'stories', label: 'Stories', className: 'col-stories' },
  { key: 'interactions', label: 'Interactions', className: 'col-inter' },
  { key: 'views', label: 'Views', className: 'col-views' },
  { key: 'change', label: 'Trend', className: 'col-trend' },
];
const SORT_VALUE = {
  name: (s) => s.name.toLowerCase(),
  stories: (s) => s.stats.storyCount,
  interactions: (s) => s.stats.interactions ?? s.stats.mentions ?? 0,
  views: (s) => s.stats.views ?? -1,
  change: (s) => s.stats.change ?? -Infinity,
};
const SUGGESTED_SHOWN = 9;
// While a collection is queued or running, ask how it's going this often.
const POLL_MS = 10_000;

const slotName = (group) => (group === 'keyword' ? 'brand or topic' : 'creator or subreddit');
const isCollecting = (status) => status?.state === 'queued' || status?.state === 'running';
// The toast after a follow; `collecting` means the first collection is already on its way.
const followedText = (name, res, group) => `Following ${name}.${res.collecting ? ' Collecting now.' : ''}${res.lastSlot ? ` That was your last ${slotName(group)} slot.` : ''}`;
const isQuiet = (item) => Boolean(item.follow?.active && item.collected !== false && item.stats.storyCount === 0);
const activity = (item) => item.stats.interactions ?? item.stats.mentions ?? 0;
const bySignal = (a, b) => b.stats.storyCount - a.stats.storyCount || activity(b) - activity(a) || a.name.localeCompare(b.name);
const followRef = (item) => ({ kind: item.kind, creatorId: item.creatorId ?? null, name: item.name, key: item.key });
const anchorOf = (event) => {
  const r = event.currentTarget.getBoundingClientRect();
  return { x: r.right, y: r.bottom };
};

// The photo with a ring of channel slices around it; click the ring for the channels.
const ring = (item, size) => (
  <ChannelRing name={item.name} kind={item.kind} photo={item.photo} handles={item.handles} channels={item.stats.channels} collected={item.collected} size={size} />
);

// Each channel's week for one creator or subreddit, and the stories they're in.
function Breakdown({ item, collecting }) {
  const { stats } = item;
  if (!item.collected) {
    return (
      <div className="expand">
        <p className="muted-note">
          {collecting
            ? `We’re collecting ${item.name} now. Their numbers and stories show up here in a few minutes.`
            : `Nothing has been collected for ${item.name} yet. Use “Collect now” above to start.`}
        </p>
      </div>
    );
  }
  const reddit = item.kind === 'community';
  const keyword = item.kind === 'keyword';
  const where = (platform) => {
    const handle = item.handles.find((h) => h.platform === platform);
    return handle ? { label: handle.handle, url: handle.url } : { label: item.name, url: `https://www.reddit.com/${item.name}/` };
  };
  return (
    <div className="expand">
      <div className="tablewrap">
        {keyword ? (
          // Where the word came up: posts on each platform that mention it, this week and the week before.
          <table className="ctable">
            <thead>
              <tr>
                <th scope="col">Platform</th>
                <th scope="col">Posts mentioning it</th>
                <th scope="col">vs last week</th>
              </tr>
            </thead>
            <tbody>
              {stats.channels.length ? (
                stats.channels.map((c) => (
                  <tr key={c.platform}>
                    <td>
                      <span className="ch">
                        <PlatformMark platform={c.platform} size="xs" />
                        {PLATFORM_NAMES[c.platform] ?? c.platform}
                      </span>
                    </td>
                    <td>{c.posts.toLocaleString('en-IN')}</td>
                    <td>{c.change == null ? '—' : <Change value={c.change} />}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3} className="none">
                    No posts mention “{item.name}” in the last two weeks.
                  </td>
                </tr>
              )}
            </tbody>
            {stats.channels.length > 1 ? (
              <tfoot>
                <tr>
                  <td>All platforms</td>
                  <td>{stats.mentions.toLocaleString('en-IN')}</td>
                  <td>{stats.change == null ? '—' : <Change value={stats.change} />}</td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        ) : (
          <table className="ctable">
            <thead>
              <tr>
                <th scope="col">Channel</th>
                <th scope="col">{reddit ? 'Threads' : 'Posts'}</th>
                <th scope="col">{reddit ? 'Upvotes and comments' : 'Interactions'}</th>
                <th scope="col">Views</th>
                <th scope="col">vs last week</th>
              </tr>
            </thead>
            <tbody>
              {stats.channels.map((c) => (
                <tr key={c.platform}>
                  <td>
                    <span className="ch">
                      <PlatformMark platform={c.platform} size="xs" />
                      <a href={where(c.platform).url} target="_blank" rel="noopener noreferrer">
                        {where(c.platform).label}
                      </a>
                    </span>
                  </td>
                  <td>{c.posts.toLocaleString('en-IN')}</td>
                  <td>{compact(c.interactions)}</td>
                  <td>{compact(c.views)}</td>
                  <td>{c.change == null ? '—' : <Change value={c.change} />}</td>
                </tr>
              ))}
            </tbody>
            {stats.channels.length > 1 ? (
              <tfoot>
                <tr>
                  <td>All channels</td>
                  <td>{stats.posts.toLocaleString('en-IN')}</td>
                  <td>{compact(stats.interactions)}</td>
                  <td>{compact(stats.views)}</td>
                  <td>{stats.change == null ? '—' : <Change value={stats.change} />}</td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        )}
      </div>
      <div className="exp-side">
        {stats.stories.length ? (
          <StoryStrip stories={stats.stories} label={`Latest stories with ${item.name}`} />
        ) : (
          <>
            <h4>In stories this week</h4>
            <p className="muted-note">None this week.{item.follow?.active ? ' Pausing frees the slot until they’re busy again.' : ''}</p>
          </>
        )}
        {stats.storyCount > stats.stories.length && item.follow ? (
          <Link className="exp-more" href={`/stories?follow=${item.follow.id}`}>
            All {stats.storyCount} stories
          </Link>
        ) : null}
        <p className="exp-note">
          {keyword
            ? `A post or story counts when it uses “${item.name}” as a whole word, on any platform. “vs last week” is blank until an earlier week has been collected.`
            : 'Interactions are likes, comments and shares on posts from these 7 days. “vs last week” is blank until an earlier week has been collected.'}
        </p>
      </div>
    </div>
  );
}

export default function FollowingView({ sources, keywords, totalStories, plan, refreshStatus = null }) {
  const router = useRouter();
  const [tab, setTab] = useState('all');
  const [sort, setSort] = useState({ key: 'stories', dir: 'desc' });
  const [expanded, setExpanded] = useState(() => new Set());
  const [menu, setMenu] = useState(null);
  const [busy, setBusy] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [toast, setToast] = useState(null);
  const [limit, setLimit] = useState(null);
  const [status, setStatus] = useState(refreshStatus);
  const [starting, setStarting] = useState(false);
  const [, startTransition] = useTransition();
  const listHeading = useRef(null);
  const current = useRef({ sources, keywords });
  current.current = { sources, keywords };
  const collecting = isCollecting(status);
  const wasCollecting = useRef(collecting);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(timer);
  }, [toast]);

  // Each server render brings the collection's state as the database has it.
  useEffect(() => setStatus(refreshStatus), [refreshStatus]);

  // While a collection is queued or running, check on it; when it finishes, reload the numbers.
  useEffect(() => {
    if (!collecting) return undefined;
    let stopped = false;
    const id = setInterval(async () => {
      try {
        const res = await fetch('/api/refresh', { cache: 'no-store' });
        if (res.ok && !stopped) setStatus(await res.json());
      } catch {
        // A missed poll is fine; the next one tries again.
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [collecting]);

  useEffect(() => {
    if (wasCollecting.current && !collecting) {
      if (status?.lastError) say(`The collection didn’t finish. ${status.lastError}`);
      else router.refresh();
    }
    wasCollecting.current = collecting;
  }, [collecting, status, router]);

  // Menus and the limit message close on a click elsewhere or Escape; the message also on scroll.
  useEffect(() => {
    const away = (event) => {
      if (!event.target.closest?.('.act')) setMenu(null);
      if (!event.target.closest?.('.limit-pop')) setLimit(null);
    };
    const escape = (event) => {
      if (event.key !== 'Escape') return;
      setMenu(null);
      setLimit(null);
    };
    const scrolled = () => setLimit(null);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    window.addEventListener('scroll', scrolled, { passive: true });
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('scroll', scrolled);
    };
  }, []);

  useEffect(() => {
    if (menu) document.querySelector('.menu [role="menuitem"]')?.focus();
  }, [menu]);

  const say = (text, undo = null) => setToast({ id: Date.now(), text, undo });

  // A follow (or resume) that started a collection: show it as under way until the next poll says otherwise.
  const startedCollecting = (res) => {
    if (res?.collecting) setStatus((s) => ({ ...(s ?? {}), state: 'queued', lastError: null }));
  };

  // The "Collect now" button: the same request as Refresh on the Stories page, so its rules apply.
  async function collectNow() {
    setStarting(true);
    try {
      const res = await fetch('/api/refresh', { method: 'POST', cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (data.status) setStatus(data.status);
      if (res.status === 401) say('Sign in again to collect.');
      else if (!res.ok) say('Couldn’t start collecting just now. Try again in a minute.');
      else if (!data.ok) say(data.message || 'Couldn’t start collecting just now.');
      else say('Collecting now. Numbers show up in a few minutes.');
    } catch {
      say('Couldn’t reach Content-Story. Check your connection and try again.');
    } finally {
      setStarting(false);
    }
  }

  function run(key, action, done) {
    setBusy(key);
    setMenu(null);
    startTransition(async () => {
      const res = await action();
      setBusy(null);
      done(res);
    });
  }

  function follow(ref, anchor) {
    run(ref.key, () => followAction(ref), (res) => {
      if (res.error) return res.limit && anchor ? setLimit({ ...res.limit, ...anchor }) : say(res.error);
      startedCollecting(res);
      say(followedText(ref.name, res, ref.kind === 'keyword' ? 'keyword' : 'source'), () => {
        const now = [...current.current.sources, ...current.current.keywords].find((i) => i.key === ref.key);
        if (now?.follow) run(ref.key, () => unfollowAction(now.follow.id), (r) => say(r.error ?? `Stopped following ${ref.name}.`));
      });
    });
  }

  function unfollow(item) {
    run(item.key, () => unfollowAction(item.follow.id), (res) => {
      if (res.error) return say(res.error);
      say(`Unfollowed ${item.name}.`, () => follow({ ...followRef(item), watchlistIds: res.undo?.watchlistIds ?? [] }));
    });
  }

  function pause(item) {
    run(item.key, () => setPausedAction(item.follow.id, true), (res) => {
      if (res.error) return say(res.error);
      say(`Paused ${item.name}. It stays in your list and frees a slot.`, () => resume(item));
    });
  }

  function resume(item, anchor) {
    run(item.key, () => setPausedAction(item.follow.id, false), (res) => {
      if (res.error) return res.limit && anchor ? setLimit({ ...res.limit, ...anchor }) : say(res.error);
      startedCollecting(res);
      say(`Resumed ${item.name}.${res.collecting ? ' Collecting now.' : ''}`);
    });
  }

  function showQuiet() {
    setLimit(null);
    setTab('quiet');
    listHeading.current?.scrollIntoView({ block: 'start' });
  }

  const toggle = (key) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const sortBy = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'name' ? 'asc' : 'desc' }));

  // Everything followed or paused, whatever its kind, is one list.
  const mine = [...sources, ...keywords].filter((s) => s.follow);
  const counts = {
    all: mine.length,
    creator: mine.filter((s) => s.kind === 'creator').length,
    community: mine.filter((s) => s.kind === 'community').length,
    keyword: mine.filter((s) => s.kind === 'keyword').length,
    quiet: mine.filter(isQuiet).length,
  };
  const inTab = mine.filter((s) => (tab === 'all' ? true : tab === 'quiet' ? isQuiet(s) : s.kind === tab));
  const dir = sort.dir === 'asc' ? 1 : -1;
  const live = inTab
    .filter((s) => s.follow.active && s.collected)
    .sort((a, b) => {
      const va = SORT_VALUE[sort.key](a);
      const vb = SORT_VALUE[sort.key](b);
      return (va < vb ? -dir : va > vb ? dir : 0) || a.name.localeCompare(b.name);
    });
  const waiting = inTab.filter((s) => s.follow.active && !s.collected);
  const paused = inTab.filter((s) => s.follow.paused);
  const suggested = sources.filter((s) => !s.follow && s.collected).sort(bySignal);
  const suggestedKeywords = keywords.filter((k) => !k.follow && k.stats.storyCount > 0).sort(bySignal);

  const followMenu = (item) => {
    const open = menu === item.key;
    return (
      <div className="act">
        <button type="button" className="btn ghost sm menubtn" aria-haspopup="menu" aria-expanded={open} disabled={busy === item.key} onClick={() => setMenu(open ? null : item.key)}>
          {busy === item.key ? (
            'Saving…'
          ) : item.follow.paused ? (
            'Paused'
          ) : (
            <>
              <Icon name="check" size={14} /> Following
            </>
          )}
          <Icon name="chevron" size={14} />
        </button>
        {open ? (
          <div className="menu" role="menu" aria-label={item.name}>
            {item.follow.paused ? (
              <button type="button" role="menuitem" onClick={(e) => resume(item, anchorOf(e))}>
                Resume
                <small>Starts collecting again and uses a slot</small>
              </button>
            ) : (
              <button type="button" role="menuitem" onClick={() => pause(item)}>
                Pause
                <small>Stays in your list and frees a slot</small>
              </button>
            )}
            <button type="button" role="menuitem" className="danger" onClick={() => unfollow(item)}>
              Unfollow
              <small>Removes it from your list</small>
            </button>
          </div>
        ) : null}
      </div>
    );
  };

  const listRow = (s) => {
    const open = expanded.has(s.key);
    return (
      <li key={s.key} className={`lrow${s.follow.paused ? ' paused' : ''}`}>
        <div className="lcols">
          <div className={`rowlead${open ? ' open' : ''}`}>
            <button type="button" className="rowchev" tabIndex={-1} aria-hidden="true" onClick={() => toggle(s.key)}>
              <Icon name="chevron" size={14} />
            </button>
            {ring(s, 'md')}
            <button type="button" className="rowtoggle" aria-expanded={open} onClick={() => toggle(s.key)}>
              <span className="rt-body">
                <span className="nameline">
                  <b>{s.name}</b>
                </span>
                <span className="rt-meta">
                  <span>{s.kind === 'community' ? 'Subreddit' : s.kind === 'keyword' ? 'Brand or topic · whole word, any platform' : s.handles[0]?.handle}</span>
                  {s.follow.paused ? (
                    <span className="chip paused">Paused · not using a slot</span>
                  ) : !s.collected ? (
                    <span className="chip pending">{collecting ? 'Collecting now…' : 'Not collected yet'}</span>
                  ) : isQuiet(s) ? (
                    <span className="chip quiet">No stories this week</span>
                  ) : null}
                  {s.collected ? (
                    <span className="m-only">
                      {plural(s.stats.storyCount, 'story', 'stories')} · {s.kind === 'keyword' ? plural(s.stats.mentions, 'mention') : `${compact(s.stats.interactions)} interactions`}
                    </span>
                  ) : null}
                </span>
              </span>
            </button>
          </div>
          <span className={`cell col-stories${s.stats.storyCount ? '' : ' none'}`}>
            {!s.collected ? '—' : s.stats.storyCount ? <Link href={`/stories?follow=${s.follow.id}`}>{s.stats.storyCount}</Link> : '0'}
          </span>
          <span className={`cell col-inter${s.collected ? '' : ' none'}`}>
            {!s.collected ? (
              '—'
            ) : s.kind === 'keyword' ? (
              <>
                {compact(s.stats.mentions)} <small className="unit">mentions</small>
              </>
            ) : (
              compact(s.stats.interactions)
            )}
          </span>
          <span className={`cell col-views${s.stats.views == null ? ' none' : ''}`}>{compact(s.stats.views)}</span>
          <span className="cell col-trend">
            {s.collected ? (
              <>
                <Sparkline values={s.stats.daily} label={s.kind === 'keyword' ? `Posts mentioning ${s.name} each day, last 7 days` : `Interactions each day for ${s.name}, last 7 days`} />
                <Change value={s.stats.change} />
              </>
            ) : (
              <span className="none">—</span>
            )}
          </span>
          {followMenu(s)}
        </div>
        {open ? <Breakdown item={s} collecting={collecting} /> : null}
      </li>
    );
  };

  const suggestedCard = (s) => (
    <article key={s.key} className="person">
      {ring(s, 'lg')}
      <div className="person-body">
        <span className="nameline">
          <b>{s.name}</b>
          {s.kind === 'creator' ? null : <span className="kindtag">Subreddit</span>}
        </span>
        <span className="numbers">
          {s.stats.storyCount ? (
            <span>
              <b>{s.stats.storyCount}</b> {s.stats.storyCount === 1 ? 'story' : 'stories'}
            </span>
          ) : null}
          <span>
            <b>{compact(s.stats.interactions)}</b> {s.kind === 'community' ? 'upvotes and comments' : 'interactions'}
          </span>
          <Change value={s.stats.change} />
        </span>
      </div>
      <button type="button" className="btn primary sm" disabled={busy === s.key} onClick={(e) => follow(followRef(s), anchorOf(e))}>
        {busy === s.key ? 'Following…' : 'Follow'}
      </button>
    </article>
  );

  let limitMessage = null;
  if (limit) {
    const quiet = mine.filter((i) => (i.kind === 'keyword') === (limit.group === 'keyword')).filter(isQuiet).length;
    const includes =
      limit.group === 'keyword' ? plural(plan.maxKeywords, 'brand or topic', 'brands and topics') : plural(plan.maxSources, 'creator or subreddit', 'creators and subreddits');
    limitMessage = (
      <div
        className="limit-pop"
        role="dialog"
        aria-labelledby="limit-title"
        style={{ left: Math.max(12, Math.min(limit.x - 300, window.innerWidth - 312)), top: Math.max(12, Math.min(limit.y + 8, window.innerHeight - 200)) }}
      >
        <b id="limit-title">No {slotName(limit.group)} slots left</b>
        <p>
          {plan.name} includes {includes}.{' '}
          {quiet ? `${quiet} of yours ${quiet === 1 ? 'has' : 'have'} no stories this week. Pause or unfollow one to make room, or upgrade.` : 'Pause or unfollow one to make room, or upgrade.'}
        </p>
        <div className="limit-actions">
          {quiet ? (
            <button type="button" className="btn primary sm" onClick={showQuiet}>
              Show quiet ones
            </button>
          ) : null}
          <Link href="/billing" className="btn ghost sm">
            See plans
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <CreatorFinder
        mode="follow"
        onToast={(text) => say(text)}
        onLimit={(anchor, lim) => setLimit({ ...lim, ...anchor })}
        onFollowed={startedCollecting}
        placeholder="Search a name, paste a profile link, type r/subreddit, or a brand or topic"
      />

      <section className="fsection" aria-labelledby="h-list">
        <div className="fsection-head">
          <h2 id="h-list" ref={listHeading}>
            Your list
          </h2>
          <p>Creators, subreddits, brands and topics · click a name for the week’s detail</p>
        </div>
        {mine.length ? (
          <>
            <div className="seg" role="group" aria-label="Show">
              {TABS.map((t) => (
                <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
                  {t.label}
                  <span className="tabcount">{counts[t.id]}</span>
                </button>
              ))}
            </div>
            <ul className="ltable">
              {inTab.length ? (
                <>
                  <li className="lhead lcols">
                    {COLUMNS.map((c) => (
                      <button key={c.key} type="button" className={`sortbtn ${c.className}`} aria-pressed={sort.key === c.key} title={`Sort by ${c.label.toLowerCase()}`} onClick={() => sortBy(c.key)}>
                        {c.label}
                        {sort.key === c.key ? <Icon name={sort.dir === 'asc' ? 'arrowUp' : 'arrowDown'} size={12} /> : null}
                      </button>
                    ))}
                    <span />
                  </li>
                  {live.map(listRow)}
                  {waiting.length ? (
                    <>
                      <li className="lgroup">
                        <b>{collecting ? 'Collecting now' : 'Not collected yet'}</b>
                        <span>
                          {collecting
                            ? 'Numbers and stories show up here in a few minutes'
                            : status?.lastError
                              ? `The last collection didn’t finish. ${status.lastError}`
                              : 'Nothing has been collected for these yet'}
                        </span>
                        {!collecting && status?.enabled !== false ? (
                          <button type="button" className="linkbtn" disabled={starting} onClick={collectNow}>
                            {starting ? 'Starting…' : status?.lastError ? 'Try again' : 'Collect now'}
                          </button>
                        ) : null}
                      </li>
                      {waiting.map(listRow)}
                    </>
                  ) : null}
                  {paused.length ? (
                    <>
                      <li className="lgroup">
                        <b>Paused</b>
                        <span>Not collected, not using a slot</span>
                      </li>
                      {paused.map(listRow)}
                    </>
                  ) : null}
                </>
              ) : (
                <li className="list-empty">{tab === 'quiet' ? 'Everything you follow is in a story this week.' : 'Nothing here yet.'}</li>
              )}
            </ul>
          </>
        ) : (
          <p className="list-empty boxed">You don’t follow anyone or anything yet. Search above, or follow a suggestion below.</p>
        )}
      </section>

      <section className="fsection" aria-labelledby="h-suggested">
        <div className="fsection-head">
          <h2 id="h-suggested">Suggested creators and subreddits</h2>
          <p>From this week’s {plural(totalStories, 'story', 'stories')}, busiest first</p>
        </div>
        {suggested.length ? (
          <div className="people">{(showAll ? suggested : suggested.slice(0, SUGGESTED_SHOWN)).map(suggestedCard)}</div>
        ) : (
          <p className="muted-note">You follow every creator and subreddit we collect.</p>
        )}
        {suggested.length > SUGGESTED_SHOWN ? (
          <button type="button" className="linkbtn more" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show fewer' : `Show ${suggested.length - SUGGESTED_SHOWN} more`}
          </button>
        ) : null}
      </section>

      <section className="fsection" aria-labelledby="h-brands">
        <div className="fsection-head">
          <h2 id="h-brands">Suggested brands and topics</h2>
          <p>Named in this week’s stories · a follow flags every story that uses the word, on any platform</p>
        </div>
        {!counts.keyword ? <p className="muted-note">You don’t follow any brands or topics yet. Type your brand or a competitor in the search box above, or pick one below.</p> : null}
        {suggestedKeywords.length ? (
          <>
            <div className="suggest">
              {suggestedKeywords.map((k) => (
                <button key={k.key} type="button" className="suggest-chip" disabled={busy === k.key} title={`Follow ${k.name}`} onClick={(e) => follow(followRef(k), anchorOf(e))}>
                  <Icon name="plus" size={13} />
                  {k.name}
                  <span className="suggest-n">{k.stats.storyCount}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="muted-note">Every brand and topic named in this week’s stories is already in your list.</p>
        )}
      </section>

      {limitMessage}
      <div className="toasts" role="status" aria-live="polite">
        {toast ? (
          <div className="toast" key={toast.id}>
            <p>{toast.text}</p>
            {toast.undo ? (
              <button
                type="button"
                onClick={() => {
                  const undo = toast.undo;
                  setToast(null);
                  undo();
                }}
              >
                Undo
              </button>
            ) : null}
            <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => setToast(null)}>
              <Icon name="close" size={14} />
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}
