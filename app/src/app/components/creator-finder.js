'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { PLATFORM_NAMES, plural } from '../../../lib/format.js';
import { CREATOR_PLATFORMS, detectPlatform, looksLikeProfile, nameFromHandle, parseHandle } from '../../../lib/profiles.js';
import { createCreatorAction, followCreatorByIdAction, unfollowCreatorByIdAction } from '../actions/creators.js';
import Avatar from './avatar.js';
import Icon from './icons.js';
import PlatformMark from './platform-mark.js';

const reach = (c) =>
  !c.covered ? 'New · collected once daily collection runs' : c.story_ids.length ? `In ${plural(c.story_ids.length, 'story', 'stories')} this week` : `${plural(c.posts, 'post')} collected`;

async function findCreators(q, platform) {
  const params = new URLSearchParams({ q });
  if (platform) params.set('platform', platform);
  const res = await fetch(`/api/creators?${params}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('Search isn’t available right now. Reload the page and try again.');
  return res.json();
}

// nameGuessed: the name came from a handle, so the form opens with it selected for typing over.
const blankComposer = (patch) => ({ name: '', nameGuessed: false, profiles: [], link: '', hint: null, askPlatform: null, checking: false, rowError: null, existing: null, error: null, ...patch });

// One box to find or add a creator. Typing a name searches everyone we know; pasting a profile
// link shows whether we already cover them, or opens a short form to add them with each
// platform they post on.
// mode 'follow' follows straight away (Following page); mode 'pick' hands creators to onPick
// (onboarding, which saves picks at the end).
export default function CreatorFinder({ mode = 'follow', pickedIds = [], onPick, placeholder = 'Search creators by name, or paste a profile link' }) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState(null);
  const [composer, setComposer] = useState(null);
  const [notice, setNotice] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [pending, startTransition] = useTransition();
  const latest = useRef(0);
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const q = query.trim();

  const patchComposer = (patch) => setComposer((c) => (c ? { ...c, ...patch } : c));
  const openComposer = (patch) => {
    setNotice(null);
    setComposer(blankComposer(patch));
  };

  useEffect(() => {
    if (q.length < 2) {
      setFound(null);
      return undefined;
    }
    const id = ++latest.current;
    setFound(null);
    const timer = setTimeout(
      () => {
        findCreators(q)
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

  const reset = () => {
    setQuery('');
    setFound(null);
    setComposer(null);
  };

  const targetOf = (c) => (c.id in overrides ? overrides[c.id] : c.target_id);
  const isPicked = (c) => pickedIds.includes(c.id);

  function act(creator) {
    setNotice(null);
    if (mode === 'pick') {
      onPick?.(creator);
      return;
    }
    const following = Boolean(targetOf(creator));
    setBusyId(creator.id);
    startTransition(async () => {
      const res = following ? await unfollowCreatorByIdAction(creator.id) : await followCreatorByIdAction(creator.id);
      setBusyId(null);
      if (res.error) {
        setNotice({ ok: false, text: res.error });
        return;
      }
      setOverrides((o) => ({ ...o, [creator.id]: following ? null : (res.creator?.target_id ?? 'following') }));
      setNotice({ ok: true, text: following ? `Unfollowed ${creator.name}.` : `Following ${creator.name}.` });
    });
  }

  function chooseExisting(creator) {
    reset();
    if (mode === 'pick') {
      if (!isPicked(creator)) onPick?.(creator);
    } else if (!targetOf(creator)) act(creator);
  }

  async function choosePlatform(platform) {
    try {
      const data = await findCreators(q, platform);
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

    if (platform === 'reddit') return patchComposer({ link: raw, rowError: 'That’s a subreddit. Follow subreddits in their own section.' }), null;
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
      data = await findCreators(raw, platform);
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
      const res = await createCreatorAction({ name, profiles: profiles.map((p) => ({ platform: p.platform, input: p.url })), follow: mode !== 'pick' });
      if (res.error) return patchComposer({ error: res.existing ? null : res.error, existing: res.existing ?? null });
      reset();
      if (mode === 'pick') {
        onPick?.(res.creator, { created: true });
        setNotice({ ok: true, text: `Added ${res.creator.name}.` });
      } else {
        setNotice({ ok: true, text: `Following ${res.creator.name}. We start collecting their posts in the next daily run.` });
      }
    });
  }

  function rowButton(c) {
    if (mode === 'pick') {
      const on = isPicked(c);
      return (
        <button type="button" className={`btn sm ${on ? 'ghost' : 'primary'}`} aria-pressed={on} onClick={() => act(c)}>
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
    const following = Boolean(targetOf(c));
    if (pending && busyId === c.id) {
      return (
        <button type="button" className="btn sm ghost" disabled>
          Saving…
        </button>
      );
    }
    return following ? (
      <button type="button" className="btn sm ghost following-btn" onClick={() => act(c)} title={`Unfollow ${c.name}`}>
        <span className="when-idle">
          <Icon name="check" size={14} /> Following
        </span>
        <span className="when-hover">Unfollow</span>
      </button>
    ) : (
      <button type="button" className="btn sm primary" onClick={() => act(c)}>
        Follow
      </button>
    );
  }

  const renderRow = (c) => (
    <li key={c.id} className="result">
      <Avatar name={c.name} size="md" />
      <span className="result-body">
        <b>{c.name}</b>
        <span className="marks">
          {c.handles.map((h) => (
            <PlatformMark key={h.platform} platform={h.platform} size="xs" />
          ))}
        </span>
        <span className="result-meta">{reach(c)}</span>
      </span>
      {rowButton(c)}
    </li>
  );

  let panel = null;
  if (composer) {
    panel = (
      <Composer
        state={composer}
        mode={mode}
        pending={pending}
        followingExisting={composer.existing ? Boolean(targetOf(composer.existing)) || isPicked(composer.existing) : false}
        onChange={patchComposer}
        onAdd={(platform, raw) => addProfile(platform, raw)}
        onRemove={(platform) => setComposer((c) => c && { ...c, profiles: c.profiles.filter((p) => p.platform !== platform) })}
        onSubmit={submitComposer}
        onCancel={reset}
        onUseExisting={chooseExisting}
      />
    );
  } else if (q.length >= 2) {
    if (!found) {
      panel = (
        <div className="finder-panel">
          <p className="finder-status">{looksLikeProfile(q) ? 'Checking that profile…' : 'Searching…'}</p>
        </div>
      );
    } else if (found.kind === 'search') {
      panel = (
        <div className="finder-panel">
          {found.creators.length ? <ul className="results">{found.creators.map(renderRow)}</ul> : <p className="finder-status">Nobody matches “{q}” yet.</p>}
          <button type="button" className="finder-add" onClick={() => openComposer({ name: q })}>
            <Icon name="plus" size={16} />
            {found.creators.length ? `Not listed? Add “${q}” as a new creator` : `Add “${q}” as a new creator`}
          </button>
        </div>
      );
    } else if (found.kind === 'lookup' && found.status === 'existing') {
      panel = (
        <div className="finder-panel">
          <p className="finder-status">{found.creator.covered ? 'We already cover this creator.' : 'This creator is already on Content-Story.'}</p>
          <ul className="results">{renderRow(found.creator)}</ul>
        </div>
      );
    } else if (found.kind === 'lookup' && found.status === 'needs-platform') {
      panel = (
        <div className="finder-panel">
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
        <div className="finder-panel">
          <p className="finder-status err">{found.message ?? 'That didn’t work. Try a profile link.'}</p>
        </div>
      );
    }
  }

  return (
    <div className="finder">
      <div className="finder-box">
        <Icon name="search" size={18} />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setComposer(null);
            setNotice(null);
          }}
          placeholder={placeholder}
          aria-label="Find or add a creator"
          autoComplete="off"
          spellCheck={false}
        />
        {query || composer ? (
          <button type="button" className="iconbtn sm" aria-label="Clear" onClick={reset}>
            <Icon name="close" size={15} />
          </button>
        ) : null}
      </div>
      {!q && !composer && !notice ? (
        <p className="finder-hint">
          Search a name, or paste a link from X, YouTube, LinkedIn, Instagram or TikTok.{' '}
          <button type="button" className="linkbtn" onClick={() => openComposer({})}>
            Add someone new
          </button>
        </p>
      ) : null}
      {notice ? (
        <p role="status" className={`notice ${notice.ok ? 'ok' : 'err'}`}>
          {notice.text}
        </p>
      ) : null}
      {panel}
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
  const canSubmit = !pending && !state.checking && (state.profiles.length > 0 || state.link.trim());

  return (
    <section className="composer" aria-labelledby="composer-title">
      <div className="composer-head">
        <h3 id="composer-title">Add a new creator</h3>
        <button type="button" className="iconbtn sm" aria-label="Close" onClick={onCancel}>
          <Icon name="close" size={15} />
        </button>
      </div>

      <div className="composer-id">
        <Avatar name={name || '?'} size="lg" />
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

      <div className="composer-profiles">
        <span className="composer-label">Profiles</span>
        <p className="composer-sub">Add every platform they post on, so their posts join up into one story.</p>
        {state.profiles.length ? (
          <ul className="profile-rows">
            {state.profiles.map((p) => (
              <li key={p.platform} className="profile-row">
                <PlatformMark platform={p.platform} size="sm" />
                <span className="pr-platform">{PLATFORM_NAMES[p.platform]}</span>
                <a href={p.url} target="_blank" rel="noopener noreferrer">
                  {p.handle}
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
            That profile belongs to <b>{state.existing.name}</b>, who’s already on Content-Story.
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

      <p className="composer-note">Free during the beta. We start collecting their posts in the next daily run; their stories show up in Your stories after that.</p>
      <div className="composer-foot">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={!canSubmit} onClick={onSubmit}>
          {pending ? 'Adding…' : mode === 'pick' ? `Add${name ? ` ${name}` : ' creator'}` : `Follow${name ? ` ${name}` : ''}`}
        </button>
      </div>
    </section>
  );
}
