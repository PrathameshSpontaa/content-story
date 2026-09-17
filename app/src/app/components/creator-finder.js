'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import { PLATFORM_NAMES, plural } from '../../../lib/format.js';
import { CREATOR_PLATFORMS, detectPlatform, looksLikeProfile, nameFromHandle, parseHandle } from '../../../lib/profiles.js';
import { createCreatorAction, followByNameAction, followCreatorByIdAction } from '../actions/creators.js';
import Face from './face.js';
import Icon from './icons.js';
import PlatformMark from './platform-mark.js';
import { Change, Numbers, SplitBar } from './source-numbers.js';

const reach = (c) =>
  !c.covered ? 'New · collected as soon as you follow' : c.story_ids.length ? `In ${plural(c.story_ids.length, 'story', 'stories')} this week` : `${plural(c.posts, 'post')} collected`;

// The toast after a follow; `collecting` means the first collection is already on its way.
const followedText = (name, res, kind) => `Following ${name}.${res.collecting ? ' Collecting now.' : ''}${res.lastSlot ? ` That was your last ${slotName(kind)} slot.` : ''}`;

async function findCreators(q, { platform, all } = {}) {
  const params = new URLSearchParams({ q });
  if (platform) params.set('platform', platform);
  if (all) params.set('scope', 'all');
  const res = await fetch(`/api/creators?${params}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('Search isn’t available right now. Reload the page and try again.');
  return res.json();
}

// The channel finder: a name or one profile link in, every channel it found out (see lib/finder.js).
// Takes 10–60 seconds. Throws with a message a person can act on.
export async function askFinder(body) {
  const res = await fetch('/api/creators/find', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'We couldn’t search for them just now. Paste their profile links instead.');
  return data;
}

export const Spinner = () => <span className="spin-dot" aria-hidden="true" />;

// nameGuessed: the name came from a handle, so the form opens with it selected for typing over.
// finding: the finder is looking for their channels; checked: it has, so the creator is saved as checked.
const blankComposer = (patch) => ({
  name: '', nameGuessed: false, profiles: [], link: '', hint: null, askPlatform: null, checking: false, rowError: null, existing: null, error: null,
  finding: false, checked: false, about: '', foundNote: null, ...patch,
});

const slotName = (kind) => (kind === 'keyword' ? 'brand or topic' : 'creator or subreddit');
const keyOf = (kind, item) => (kind === 'creator' ? item.id : `${kind}:${item.name.toLowerCase()}`);
// Where a pressed button sits on screen, so a limit message can open beside it.
const anchorOf = (event) => {
  const r = event.currentTarget.getBoundingClientRect();
  return { x: r.right, y: r.bottom };
};

function Group({ label, children }) {
  return (
    <div className="fgroup">
      <p className="fgroup-label">{label}</p>
      <ul className="results">{children}</ul>
    </div>
  );
}

function StoriesNote({ count, target }) {
  if (!count) return <span>No stories this week</span>;
  const text = `${plural(count, 'story', 'stories')} this week`;
  return target && target !== 'following' ? <Link href={`/stories?follow=${target}`}>{text}</Link> : <span>In {text}</span>;
}

// A creator's or subreddit's week: totals across channels, how they split, the change from last
// week, and the stories they're in.
function SourceSummary({ kind, stats, target }) {
  return (
    <>
      <Numbers kind={kind} stats={stats} />
      <span className="numbers-2">
        <SplitBar channels={stats.channels} />
        <Change value={stats.change} suffix=" vs last week" />
        <StoriesNote count={stats.storyCount} target={target} />
      </span>
    </>
  );
}

// One box to find or add what to follow. Typing a name searches everyone we know; pasting a
// profile link shows whether we already cover them. Someone new opens a short form where the channel
// finder fills in every platform they post on; "Add several at once" does the same for a pasted list.
// mode 'follow' (Following page) follows straight away, also finds subreddits and brands, and shows
// each result's week; onToast and onLimit let the page report results its own way, and onFollowed
// gets each successful follow's result (whether collection started, the last slot).
// mode 'pick' hands creators to onPick (onboarding, which saves picks at the end).
export default function CreatorFinder({ mode = 'follow', pickedIds = [], onPick, onToast, onLimit, onFollowed, placeholder = 'Search creators by name, or paste a profile link' }) {
  const following = mode === 'follow';
  const [query, setQuery] = useState('');
  const [found, setFound] = useState(null);
  const [composer, setComposer] = useState(null);
  const [notice, setNotice] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [busyKey, setBusyKey] = useState(null);
  const [open, setOpen] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [pending, startTransition] = useTransition();
  const latest = useRef(0);
  const finderRun = useRef(0);
  const root = useRef(null);
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const q = query.trim();

  const patchComposer = (patch) => setComposer((c) => (c ? { ...c, ...patch } : c));
  // A new creator's form opens and the finder starts looking for all their channels straight away.
  const openComposer = (patch) => {
    setNotice(null);
    setComposer(blankComposer(patch));
    const link = patch.profiles?.[0]?.url ?? '';
    const name = patch.nameGuessed ? '' : String(patch.name ?? '').trim();
    if (link || name.length >= 2) findChannels({ name, link });
  };

  async function findChannels({ name, link }) {
    const run = ++finderRun.current;
    setComposer((c) => c && { ...c, finding: true, foundNote: null });
    let data;
    try {
      data = await askFinder({ name, link });
    } catch (err) {
      if (run === finderRun.current) setComposer((c) => c && { ...c, finding: false, foundNote: err.message });
      return;
    }
    if (run !== finderRun.current) return;
    setComposer((c) => {
      if (!c) return c;
      if (data.existing) return { ...c, finding: false, existing: data.existing, about: data.about ?? '' };
      const fresh = (data.channels ?? []).filter((ch) => !c.profiles.some((p) => p.platform === ch.platform)).map((ch) => ({ platform: ch.platform, handle: ch.handle, url: ch.url, found: true }));
      const profiles = [...c.profiles, ...fresh];
      const note = fresh.length
        ? `Found ${fresh.length === 1 ? '1 channel' : `${fresh.length} channels`}. Remove any that aren’t them.`
        : profiles.length
          ? 'No other channels found. Paste a link if they post somewhere else.'
          : 'We couldn’t find their channels. Paste one of their profile links.';
      const guessed = c.nameGuessed || !c.name.trim();
      return { ...c, finding: false, checked: true, profiles, name: guessed && data.name ? data.name : c.name, nameGuessed: guessed && !data.name, about: data.about ?? '', foundNote: note };
    });
  }

  useEffect(() => {
    if (q.length < 2) {
      setFound(null);
      return undefined;
    }
    const id = ++latest.current;
    setFound(null);
    const timer = setTimeout(
      () => {
        findCreators(q, { all: following })
          .then((data) => {
            if (id !== latest.current) return;
            // A pasted link to someone new goes straight to the form, with that profile filled in.
            if (data.kind === 'lookup' && data.status === 'new') openComposer({ name: nameFromHandle(data.profile.handle), nameGuessed: true, profiles: [data.profile] });
            else setFound(data);
          })
          .catch((err) => id === latest.current && setFound({ kind: 'error', message: err.message }));
      },
      looksLikeProfile(q) ? 0 : 250,
    );
    return () => clearTimeout(timer);
  }, [q]);

  // On the Following page results float over the page; a click elsewhere puts them away.
  useEffect(() => {
    if (!following) return undefined;
    const away = (event) => {
      if (!root.current?.contains(event.target) && !event.target.closest?.('.limit-pop')) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [following]);

  const reset = () => {
    finderRun.current += 1;
    setQuery('');
    setFound(null);
    setComposer(null);
  };

  const targetOf = (key, serverTarget) => (key in overrides ? overrides[key] : serverTarget);
  const isPicked = (c) => pickedIds.includes(c.id);
  const say = (text) => (onToast ? onToast(text) : setNotice({ ok: true, text }));

  function follow(kind, item, anchor) {
    setNotice(null);
    const key = keyOf(kind, item);
    setBusyKey(key);
    startTransition(async () => {
      const res = kind === 'creator' ? await followCreatorByIdAction(item.id) : await followByNameAction(kind, item.name);
      setBusyKey(null);
      if (res.error) {
        if (res.limit && anchor && onLimit) onLimit(anchor, res.limit);
        else setNotice({ ok: false, text: res.error });
        return;
      }
      setOverrides((o) => ({ ...o, [key]: res.creator?.target_id ?? 'following' }));
      onFollowed?.(res);
      say(followedText(res.name ?? item.name, res, kind));
    });
  }

  function chooseExisting(creator) {
    reset();
    if (mode === 'pick') {
      if (!isPicked(creator)) onPick?.(creator);
    } else if (!targetOf(creator.id, creator.target_id)) follow('creator', creator);
  }

  async function choosePlatform(platform) {
    try {
      const data = await findCreators(q, { platform, all: following });
      if (data.status === 'new') openComposer({ name: nameFromHandle(data.profile.handle), nameGuessed: true, profiles: [data.profile] });
      else setFound(data);
    } catch (err) {
      setFound({ kind: 'error', message: err.message });
    }
  }

  // Adds what's in the link box as a profile. Returns the new profile list, or null if it couldn't.
  async function addProfile(platformChoice, rawValue) {
    const c = composerRef.current;
    if (!c) return null;
    const raw = String(rawValue ?? c.link).trim();
    if (!raw) return c.profiles;
    const bare = /^@?[A-Za-z0-9._-]{1,40}$/.test(raw);
    const platform = detectPlatform(raw) ?? platformChoice ?? (bare ? c.hint : null);

    if (platform === 'reddit') return patchComposer({ link: raw, rowError: 'That’s a subreddit. Search r/ and its name in the box above to follow it.' }), null;
    if (!platform) {
      if (bare) return patchComposer({ link: raw, askPlatform: raw.startsWith('@') ? raw : `@${raw}`, rowError: null }), null;
      return patchComposer({ link: raw, rowError: 'Paste a profile link, like instagram.com/name, or a handle like @name.' }), null;
    }

    let profile;
    try {
      profile = { platform, ...parseHandle(platform, raw) };
    } catch (err) {
      return patchComposer({ link: raw, rowError: err.message, askPlatform: null }), null;
    }
    const taken = c.profiles.find((p) => p.platform === platform);
    if (taken) {
      if (taken.handle.toLowerCase() === profile.handle.toLowerCase()) return patchComposer({ link: '', askPlatform: null, rowError: null }), c.profiles;
      return patchComposer({ link: raw, askPlatform: null, rowError: `${PLATFORM_NAMES[platform]} is already added (${taken.handle}). Remove it to use a different one.` }), null;
    }

    patchComposer({ link: raw, checking: true, rowError: null, askPlatform: null });
    let data;
    try {
      data = await findCreators(raw, { platform });
    } catch (err) {
      return patchComposer({ checking: false, rowError: err.message }), null;
    }
    if (data.status === 'existing') return patchComposer({ checking: false, link: '', existing: data.creator }), null;
    if (data.status !== 'new') return patchComposer({ checking: false, rowError: data.message }), null;

    const profiles = [...c.profiles, profile];
    setComposer((cur) => cur && { ...cur, checking: false, link: '', hint: null, profiles, name: cur.name.trim() ? cur.name : nameFromHandle(profile.handle) });
    return profiles;
  }

  function submitComposer() {
    startTransition(async () => {
      let profiles = composerRef.current?.profiles ?? [];
      if (composerRef.current?.link.trim()) {
        const added = await addProfile(null);
        if (!added) return;
        profiles = added;
      }
      if (!profiles.length) return patchComposer({ rowError: 'Add at least one profile link.' });
      const name = composerRef.current?.name.trim() || nameFromHandle(profiles[0].handle);
      const res = await createCreatorAction({ name, profiles: profiles.map((p) => ({ platform: p.platform, input: p.url })), follow: mode !== 'pick', checked: composerRef.current?.checked === true });
      if (res.error) return patchComposer({ error: res.existing ? null : res.error, existing: res.existing ?? null });
      reset();
      if (mode === 'pick') {
        onPick?.(res.creator, { created: true });
        setNotice({ ok: true, text: `Added ${res.creator.name}.` });
      } else {
        onFollowed?.(res);
        say(followedText(res.creator.name, res, 'creator'));
      }
    });
  }

  function rowButton(kind, item) {
    if (mode === 'pick') {
      const on = isPicked(item);
      return (
        <button
          type="button"
          className={`btn sm ${on ? 'ghost' : 'primary'}`}
          aria-pressed={on}
          onClick={() => {
            setNotice(null);
            onPick?.(item);
          }}
        >
          {on ? (
            <>
              <Icon name="check" size={14} /> Picked
            </>
          ) : (
            'Pick'
          )}
        </button>
      );
    }
    const key = keyOf(kind, item);
    if (pending && busyKey === key) {
      return (
        <button type="button" className="btn sm ghost" disabled>
          Saving…
        </button>
      );
    }
    if (targetOf(key, item.target_id)) {
      return (
        <span className="state-on">
          <Icon name="check" size={14} /> Following
        </span>
      );
    }
    return (
      <button type="button" className="btn sm primary" onClick={(e) => follow(kind, item, anchorOf(e))}>
        Follow
      </button>
    );
  }

  const renderCreator = (c) => (
    <li key={c.id} className="result">
      <Face name={c.name} photo={c.photo} size="md" />
      <span className="result-body">
        <span className="nameline">
          <b>{c.name}</b>
          <span className="marks">
            {c.handles.map((h) => (
              <PlatformMark key={h.platform} platform={h.platform} size="xs" />
            ))}
          </span>
        </span>
        {following && c.stats && c.covered ? <SourceSummary kind="creator" stats={c.stats} target={targetOf(c.id, c.target_id)} /> : <span className="result-meta">{reach(c)}</span>}
      </span>
      {rowButton('creator', c)}
    </li>
  );

  const renderCommunity = (c) => (
    <li key={keyOf('community', c)} className="result">
      <Face name={c.name} kind="community" size="md" />
      <span className="result-body">
        <span className="nameline">
          <b>{c.name}</b>
          <span className="kindtag">Subreddit</span>
        </span>
        {c.stats ? (
          <SourceSummary kind="community" stats={c.stats} target={targetOf(keyOf('community', c), c.target_id)} />
        ) : (
          <span className="result-meta">New to Content-Story · collected as soon as you follow</span>
        )}
      </span>
      {rowButton('community', c)}
    </li>
  );

  const renderKeyword = (k) => {
    const broad = k.totalStories >= 4 && k.stats.storyCount / k.totalStories >= 0.5;
    return (
      <li key={keyOf('keyword', k)} className="result">
        <Face name={k.name} kind="keyword" size="md" />
        <span className="result-body">
          <span className="nameline">
            <b>“{k.name}”</b>
          </span>
          <Numbers kind="keyword" stats={k.stats} />
        </span>
        {rowButton('keyword', k)}
        <div className="preview">
          {k.stats.storyCount ? (
            <>
              <p>
                <b>In {plural(k.stats.storyCount, 'story', 'stories')} this week</b> <span className="muted">· matches “{k.name}” as a whole word</span>
              </p>
              <ul>
                {k.stats.stories.slice(0, 2).map((s) => (
                  <li key={s.id}>
                    <Link href={`/stories/${s.id}`}>{s.headline ?? 'Untitled story'}</Link>
                  </li>
                ))}
              </ul>
              {broad ? (
                <p className="broad">
                  That’s {k.stats.storyCount} of {k.totalStories} stories, so it will be noisy. Try something narrower, like a product name.
                </p>
              ) : null}
            </>
          ) : (
            <p>
              <b>Not in any of this week’s {plural(k.totalStories, 'story', 'stories')}.</b> We’ll flag new ones as they come in.
            </p>
          )}
        </div>
      </li>
    );
  };

  const panelClass = `finder-panel${following ? ' overlay' : ''}`;
  let panel = null;
  if (!composer && q.length >= 2 && (open || !following)) {
    if (!found) {
      panel = (
        <div className={panelClass}>
          <p className="finder-status">{looksLikeProfile(q) ? 'Checking that profile…' : 'Searching…'}</p>
        </div>
      );
    } else if (found.kind === 'search') {
      const creators = found.creators ?? [];
      const communities = found.communities ?? [];
      panel = (
        <div className={panelClass}>
          {following ? (
            <>
              {creators.length ? <Group label="Creators">{creators.map(renderCreator)}</Group> : null}
              {communities.length ? <Group label="Subreddits">{communities.map(renderCommunity)}</Group> : null}
              {found.keyword ? <Group label="Brand or topic">{renderKeyword(found.keyword)}</Group> : null}
            </>
          ) : creators.length ? (
            <ul className="results">{creators.map(renderCreator)}</ul>
          ) : (
            <p className="finder-status">Nobody matches “{q}” yet.</p>
          )}
          <button type="button" className="finder-add" onClick={() => openComposer({ name: q })}>
            <Icon name="plus" size={16} />
            {creators.length ? `Not listed? Find “${q}” on every platform` : `Find “${q}” on every platform`}
          </button>
        </div>
      );
    } else if (found.kind === 'communities') {
      const known = found.communities ?? [];
      panel = (
        <div className={panelClass}>
          {known.length || found.candidate ? (
            <Group label="Subreddits">
              {known.map(renderCommunity)}
              {found.candidate ? renderCommunity({ name: found.candidate, target_id: null }) : null}
            </Group>
          ) : (
            <p className="finder-status">Keep typing the subreddit’s name.</p>
          )}
        </div>
      );
    } else if (found.kind === 'lookup' && found.status === 'existing') {
      panel = (
        <div className={panelClass}>
          <p className="finder-status">{found.creator.covered ? 'We already cover this creator.' : 'This creator is already on Content-Story.'}</p>
          <ul className="results">{renderCreator(found.creator)}</ul>
        </div>
      );
    } else if (found.kind === 'lookup' && found.status === 'needs-platform') {
      panel = (
        <div className={panelClass}>
          <div className="platform-choices padded" role="group" aria-label={`Which platform is ${found.handle} on?`}>
            <span>
              Which platform is <b>{found.handle}</b> on?
            </span>
            {CREATOR_PLATFORMS.map((p) => (
              <button key={p} type="button" className="platform-choice" onClick={() => choosePlatform(p)}>
                <PlatformMark platform={p} size="xs" />
                {PLATFORM_NAMES[p]}
              </button>
            ))}
          </div>
        </div>
      );
    } else {
      panel = (
        <div className={panelClass}>
          <p className="finder-status err">{found.message ?? 'That didn’t work. Try a profile link.'}</p>
        </div>
      );
    }
  }

  return (
    <div className="finder" ref={root}>
      <div className="finder-field">
        <div className="finder-box">
          <Icon name="search" size={18} />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setComposer(null);
              setNotice(null);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              if (following && open && q) setOpen(false);
              else reset();
            }}
            placeholder={placeholder}
            aria-label={following ? 'Find a creator, subreddit, brand or topic' : 'Find or add a creator'}
            autoComplete="off"
            spellCheck={false}
          />
          {query || composer ? (
            <button type="button" className="iconbtn sm" aria-label="Clear" onClick={reset}>
              <Icon name="close" size={15} />
            </button>
          ) : null}
        </div>
        {panel}
      </div>
      {!composer && !bulk ? (
        <button type="button" className="linkbtn finder-bulk-toggle" onClick={() => setBulk(true)}>
          Add several at once
        </button>
      ) : null}
      {bulk ? (
        <BulkAdd
          mode={mode}
          pickedIds={pickedIds}
          onPick={onPick}
          onFollowed={onFollowed}
          onClose={() => setBulk(false)}
          onDone={(text) => {
            setBulk(false);
            say(text);
          }}
        />
      ) : null}
      {notice ? (
        <p role="status" className={`notice ${notice.ok ? 'ok' : 'err'}`}>
          {notice.text}
        </p>
      ) : null}
      {composer ? (
        <Composer
          state={composer}
          mode={mode}
          pending={pending}
          followingExisting={composer.existing ? Boolean(targetOf(composer.existing.id, composer.existing.target_id)) || isPicked(composer.existing) : false}
          onChange={patchComposer}
          onAdd={(platform, raw) => addProfile(platform, raw)}
          onRemove={(platform) => setComposer((c) => c && { ...c, profiles: c.profiles.filter((p) => p.platform !== platform) })}
          onSubmit={submitComposer}
          onCancel={reset}
          onUseExisting={chooseExisting}
        />
      ) : null}
    </div>
  );
}

function Composer({ state, mode, pending, followingExisting, onChange, onAdd, onRemove, onSubmit, onCancel, onUseExisting }) {
  const linkRef = useRef(null);
  const missing = CREATOR_PLATFORMS.filter((p) => !state.profiles.some((x) => x.platform === p));
  const name = state.name.trim();
  const placeholder = state.hint
    ? `Paste their ${PLATFORM_NAMES[state.hint]} link or handle`
    : state.profiles.length
      ? 'Paste another profile link'
      : 'Paste a profile link, like instagram.com/name';
  const canSubmit = !pending && !state.checking && !state.finding && (state.profiles.length > 0 || state.link.trim());

  return (
    <section className="composer" aria-labelledby="composer-title">
      <div className="composer-head">
        <h3 id="composer-title">Add a new creator</h3>
        <button type="button" className="iconbtn sm" aria-label="Close" onClick={onCancel}>
          <Icon name="close" size={15} />
        </button>
      </div>

      <div className="composer-id">
        <Face name={name || '?'} size="lg" />
        <label className="field">
          <span>Name</span>
          <input
            value={state.name}
            onChange={(e) => onChange({ name: e.target.value, error: null })}
            onFocus={(e) => state.nameGuessed && e.target.select()}
            placeholder="e.g. Tanmay Bhat"
            maxLength={80}
            autoComplete="off"
            autoFocus={state.nameGuessed}
          />
        </label>
      </div>
      {state.about ? <p className="composer-about">{state.about}</p> : null}

      <div className="composer-profiles">
        <span className="composer-label">Profiles</span>
        <p className="composer-sub">We look for every platform they post on. Open a link to check it’s them, remove any that aren’t, or paste one we missed.</p>
        {state.finding ? (
          <p className="composer-finding" role="status">
            <Spinner /> Looking for them on X, YouTube, LinkedIn, Instagram and TikTok. This takes up to a minute.
          </p>
        ) : null}
        {state.foundNote ? <p className="composer-found">{state.foundNote}</p> : null}
        {state.profiles.length ? (
          <ul className="profile-rows">
            {state.profiles.map((p) => (
              <li key={p.platform} className="profile-row">
                <PlatformMark platform={p.platform} size="sm" />
                <span className="pr-platform">{PLATFORM_NAMES[p.platform]}</span>
                <a href={p.url} target="_blank" rel="noopener noreferrer">
                  {p.handle}
                  {p.found ? <span className="found-tag">Found</span> : null}
                </a>
                <button type="button" className="iconbtn sm" aria-label={`Remove ${PLATFORM_NAMES[p.platform]} profile`} onClick={() => onRemove(p.platform)}>
                  <Icon name="close" size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {missing.length ? (
          <div className="profile-add">
            <input
              ref={linkRef}
              value={state.link}
              onChange={(e) => onChange({ link: e.target.value, rowError: null, askPlatform: null })}
              onPaste={(e) => {
                const text = e.clipboardData.getData('text');
                if (text.trim()) {
                  e.preventDefault();
                  onAdd(null, text);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onAdd(null);
                }
              }}
              placeholder={placeholder}
              aria-label="Profile link or handle"
              autoComplete="off"
              spellCheck={false}
              autoFocus={!state.nameGuessed}
            />
            <button type="button" className="btn ghost" disabled={state.checking || !state.link.trim()} onClick={() => onAdd(null)}>
              {state.checking ? 'Checking…' : 'Add'}
            </button>
          </div>
        ) : null}

        {state.askPlatform ? (
          <div className="platform-choices" role="group" aria-label={`Which platform is ${state.askPlatform} on?`}>
            <span>
              Which platform is <b>{state.askPlatform}</b> on?
            </span>
            {missing.map((p) => (
              <button key={p} type="button" className="platform-choice" onClick={() => onAdd(p)}>
                <PlatformMark platform={p} size="xs" />
                {PLATFORM_NAMES[p]}
              </button>
            ))}
          </div>
        ) : null}
        {state.rowError ? (
          <p className="field-error" role="alert">
            {state.rowError}
          </p>
        ) : null}
        {state.profiles.length && missing.length && !state.askPlatform ? (
          <div className="missing">
            <span>Also posts on</span>
            {missing.map((p) => (
              <button
                key={p}
                type="button"
                className={`platform-choice sm${state.hint === p ? ' on' : ''}`}
                aria-pressed={state.hint === p}
                onClick={() => {
                  onChange({ hint: p });
                  linkRef.current?.focus();
                }}
              >
                <PlatformMark platform={p} size="xs" />
                {PLATFORM_NAMES[p]}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {state.existing ? (
        <div className="notice info existing" role="status">
          <span>
            <b>{state.existing.name}</b> is already on Content-Story.
          </span>
          <button type="button" className="btn primary sm" disabled={followingExisting} onClick={() => onUseExisting(state.existing)}>
            {followingExisting ? (mode === 'pick' ? 'Already picked' : 'Already following') : mode === 'pick' ? `Pick ${state.existing.name}` : `Follow ${state.existing.name}`}
          </button>
        </div>
      ) : null}
      {state.error ? (
        <p className="notice err" role="alert">
          {state.error}
        </p>
      ) : null}

      <p className="composer-note">Free during the beta. We collect their posts as soon as you follow; their stories show up in Your stories a few minutes later.</p>
      <div className="composer-foot">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={!canSubmit} onClick={onSubmit}>
          {pending ? 'Adding…' : state.finding ? 'Finding channels…' : mode === 'pick' ? `Add${name ? ` ${name}` : ' creator'}` : `Follow${name ? ` ${name}` : ''}`}
        </button>
      </div>
    </section>
  );
}

const BULK_MAX = 25;

function bulkNote(r, pick) {
  if (r.status === 'waiting') return 'Waiting…';
  if (r.status === 'finding') return 'Finding them on every platform…';
  if (r.status === 'failed') return r.error;
  if (r.status === 'done') return pick ? 'Picked' : 'Following';
  if (r.existing) return r.already ? (pick ? 'Already picked' : 'Already following') : 'Already on Content-Story';
  return r.about || `Found on ${plural(r.channels.length, 'platform')}`;
}

// Several creators at once: names or profile links, one per line. Each is matched to someone we already
// cover or found on every platform, then all the ticked ones are followed (or picked) in one go.
function BulkAdd({ mode, pickedIds, onPick, onFollowed, onClose, onDone }) {
  const pick = mode === 'pick';
  const [text, setText] = useState('');
  const [rows, setRows] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const patch = (key, p) => setRows((list) => list?.map((r) => (r.key === key ? { ...r, ...p } : r)) ?? list);
  const known = (creator) => {
    const already = pick ? pickedIds.includes(creator.id) : Boolean(creator.target_id);
    return { status: 'ready', name: creator.name, channels: creator.handles ?? [], existing: creator, already, on: !already };
  };

  async function resolve(row) {
    patch(row.key, { status: 'finding' });
    try {
      let data;
      if (looksLikeProfile(row.input)) {
        const look = await findCreators(row.input);
        if (look.kind === 'lookup' && look.status === 'existing') return patch(row.key, known(look.creator));
        if (look.kind !== 'lookup' || look.status !== 'new') throw new Error(look.message ?? 'Paste a full profile link, like instagram.com/name.');
        data = await askFinder({ link: row.input });
      } else {
        const search = await findCreators(row.input);
        const same = (search.creators ?? []).find((c) => c.name.toLowerCase() === row.input.toLowerCase());
        if (same) return patch(row.key, known(same));
        data = await askFinder({ name: row.input });
      }
      if (data.existing) return patch(row.key, known(data.existing));
      if (!data.channels?.length) throw new Error('No channels found. Try one of their profile links.');
      patch(row.key, { status: 'ready', name: data.name || row.input, about: data.about, channels: data.channels, existing: null, on: true });
    } catch (err) {
      patch(row.key, { status: 'failed', error: err.message, on: false });
    }
  }

  async function start() {
    const lines = [...new Map(text.split(/[\n\t]/).map((l) => l.trim()).filter((l) => l.length >= 2).map((l) => [l.toLowerCase(), l])).values()];
    if (!lines.length) return setError('Paste at least one name or profile link.');
    setError(lines.length > BULK_MAX ? `Only the first ${BULK_MAX} are added this time.` : null);
    const list = lines.slice(0, BULK_MAX).map((input, i) => ({ key: `${i}:${input}`, input, status: 'waiting', on: false }));
    setRows(list);
    const queue = [...list];
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        while (queue.length) await resolve(queue.shift());
      }),
    );
  }

  async function save() {
    setSaving(true);
    setError(null);
    let done = 0;
    for (const r of rows.filter((x) => x.on && x.status === 'ready')) {
      let res;
      if (r.existing && pick) {
        onPick?.(r.existing);
        patch(r.key, { status: 'done', on: false });
        done += 1;
        continue;
      }
      if (r.existing) res = await followCreatorByIdAction(r.existing.id);
      else {
        res = await createCreatorAction({ name: r.name, profiles: r.channels.map((c) => ({ platform: c.platform, input: c.url })), follow: !pick, checked: true });
        // Someone added them in the meantime: use that creator instead.
        if (res.error && res.existing) {
          if (pick) {
            onPick?.(res.existing);
            patch(r.key, { status: 'done', on: false });
            done += 1;
            continue;
          }
          res = await followCreatorByIdAction(res.existing.id);
        }
      }
      if (res.error) {
        patch(r.key, { status: 'failed', error: res.error, on: false });
        if (res.limit) {
          setError(res.error);
          break;
        }
        continue;
      }
      if (pick) onPick?.(res.creator, { created: true });
      else onFollowed?.(res);
      patch(r.key, { status: 'done', on: false });
      done += 1;
    }
    setSaving(false);
    if (done) onDone?.(`${pick ? 'Picked' : 'Following'} ${done === 1 ? '1 creator' : `${done} creators`}.${pick ? '' : ' Collecting their posts now.'}`);
  }

  const finding = rows?.some((r) => r.status === 'waiting' || r.status === 'finding');
  const chosen = rows?.filter((r) => r.on && r.status === 'ready').length ?? 0;

  return (
    <section className="composer bulk" aria-labelledby="bulk-title">
      <div className="composer-head">
        <h3 id="bulk-title">Add several creators</h3>
        <button type="button" className="iconbtn sm" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </div>
      {!rows ? (
        <label className="field">
          <span>Names or profile links, one per line</span>
          <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Ritu David\ninstagram.com/thevarunmayya\nyoutube.com/@mkbhd'} spellCheck={false} />
        </label>
      ) : (
        <ul className="bulk-rows" aria-live="polite">
          {rows.map((r) => (
            <li key={r.key} className={`bulk-row ${r.status}`}>
              <input
                type="checkbox"
                checked={r.on}
                disabled={r.status !== 'ready' || r.already || saving}
                onChange={(e) => patch(r.key, { on: e.target.checked })}
                aria-label={`${pick ? 'Pick' : 'Follow'} ${r.name ?? r.input}`}
              />
              <span className="bulk-body">
                <span className="nameline">
                  <b>{r.name ?? r.input}</b>
                  {r.channels?.length ? (
                    <span className="marks">
                      {r.channels.map((c) => (
                        <a key={c.platform} href={c.url} target="_blank" rel="noopener noreferrer" title={`${PLATFORM_NAMES[c.platform]}: ${c.handle}`}>
                          <PlatformMark platform={c.platform} size="xs" />
                        </a>
                      ))}
                    </span>
                  ) : null}
                </span>
                <span className="pick-meta">
                  {r.status === 'finding' ? <Spinner /> : null} {bulkNote(r, pick)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {!rows ? (
        <p className="composer-note">
          Paste up to {BULK_MAX}, for example a column from a spreadsheet. We find each one on X, YouTube, LinkedIn, Instagram and TikTok; tap a platform icon to check it’s them.
        </p>
      ) : null}
      {error ? (
        <p className="notice err" role="alert">
          {error}
        </p>
      ) : null}
      <div className="composer-foot">
        <button type="button" className="btn ghost" onClick={onClose}>
          {rows && !finding ? 'Close' : 'Cancel'}
        </button>
        {!rows ? (
          <button type="button" className="btn primary" disabled={!text.trim()} onClick={start}>
            Find them
          </button>
        ) : (
          <button type="button" className="btn primary" disabled={finding || saving || !chosen} onClick={save}>
            {saving ? 'Adding…' : finding ? 'Finding…' : `${pick ? 'Pick' : 'Follow'} ${chosen === 1 ? '1 creator' : `${chosen} creators`}`}
          </button>
        )}
      </div>
    </section>
  );
}
