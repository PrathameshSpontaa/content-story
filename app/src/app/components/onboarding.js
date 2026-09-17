'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { createCreatorAction } from '../actions/creators.js';
import Avatar from './avatar.js';
import CreatorFinder, { Spinner, askFinder } from './creator-finder.js';
import Icon from './icons.js';
import PlatformMark from './platform-mark.js';

const STEPS = ['About you', 'Who to follow'];
const count = (n, one, many = `${one}s`) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
const cleanWord = (value) => value.trim().replace(/\s+/g, ' ');

const NICHE_EXAMPLES = {
  brand: 'e.g. skincare and beauty in India',
  agency: 'e.g. personal finance creators in India',
  media: 'e.g. AI and tech news',
  exploring: 'e.g. AI tools and startups',
};

// First run in two screens: who you are and what you cover, then who to follow. Following someone new
// takes their name or one link; the finder adds every platform they post on. What you cover brings
// suggested creators. Nothing is saved until the end; stories are made only from the picks.
export default function Onboarding({ firstName, useCases, creators, communities, topics, limits, initialUseCase, finish }) {
  const [step, setStep] = useState(0);
  const [creatorList, setCreatorList] = useState(creators);
  const [useCase, setUseCase] = useState(initialUseCase ?? null);
  const [niche, setNiche] = useState('');
  const [suggested, setSuggested] = useState({ status: 'idle', key: '', list: [], message: null });
  const [adding, setAdding] = useState(null);
  const [picked, setPicked] = useState(() => new Set(creators.filter((c) => c.target_id).map((c) => c.id)));
  const [subs, setSubs] = useState(() => new Set(communities.filter((c) => c.target_id).map((c) => c.name)));
  const [words, setWords] = useState(() => topics.filter((t) => t.target_id).map((t) => t.name));
  const [draft, setDraft] = useState('');
  const [error, setError] = useState(null);
  const [pending, startTransition] = useTransition();
  const subsRef = useRef(subs);
  subsRef.current = subs;
  const pickedRef = useRef(picked);
  pickedRef.current = picked;

  useEffect(() => {
    window.scrollTo({ top: 0 });
    setError(null);
  }, [step]);

  const sourcesUsed = picked.size + subs.size;
  const hasWord = (name) => words.some((w) => w.toLowerCase() === name.toLowerCase());
  const sourceLimitMessage = `${limits.planName} includes ${count(limits.maxSources, 'creator or subreddit', 'creators and subreddits')}. Unpick one to add another.`;

  // Creators and subreddits share one limit. Updates build on the latest picks, so several picks in a row
  // (adding a pasted list) all land.
  function toggleCreator(id, { add = false } = {}) {
    setError(null);
    setPicked((prev) => {
      if (prev.has(id)) {
        if (add) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      }
      if (prev.size + subsRef.current.size >= limits.maxSources) {
        setTimeout(() => setError(sourceLimitMessage));
        return prev;
      }
      return new Set(prev).add(id);
    });
  }
  function toggleSub(name) {
    setError(null);
    setSubs((prev) => {
      if (prev.has(name)) {
        const next = new Set(prev);
        next.delete(name);
        return next;
      }
      if (prev.size + pickedRef.current.size >= limits.maxSources) {
        setTimeout(() => setError(sourceLimitMessage));
        return prev;
      }
      return new Set(prev).add(name);
    });
  }

  // Someone found or added through the search box joins the list; a new creator is picked straight away.
  function pickFromFinder(creator, { created = false } = {}) {
    setCreatorList((list) => (list.some((c) => c.id === creator.id) ? list : [creator, ...list]));
    toggleCreator(creator.id, { add: created });
  }

  // Suggestions for what they cover, fetched once per niche and use case.
  async function loadSuggestions({ again = false } = {}) {
    const topic = cleanWord(niche);
    const key = `${useCase ?? ''}:${topic.toLowerCase()}`;
    if (topic.length < 3 || (key === suggested.key && !again)) return;
    setSuggested({ status: 'loading', key, list: [], message: null });
    try {
      const data = await askFinder({ suggest: true, niche: topic, useCase: useCase ?? '' });
      setSuggested((s) => (s.key === key ? { status: 'ready', key, list: data.creators ?? [], message: null } : s));
    } catch (err) {
      setSuggested((s) => (s.key === key ? { status: 'failed', key, list: [], message: err.message } : s));
    }
  }

  // A suggestion becomes a creator when it's picked (once), then counts like any other pick.
  async function pickSuggestion(s, index) {
    const id = s.creatorId ?? s.existing?.id;
    if (id) return pickFromFinder(s.existing ?? creatorList.find((c) => c.id === id) ?? { id, name: s.name, handles: s.channels });
    setAdding(index);
    const res = await createCreatorAction({ name: s.name, profiles: s.channels.map((c) => ({ platform: c.platform, input: c.url })), follow: false, checked: true });
    setAdding(null);
    const creator = res.creator ?? res.existing;
    if (!creator) return setError(res.error ?? 'We couldn’t add them. Try again.');
    setSuggested((cur) => ({ ...cur, list: cur.list.map((x, i) => (i === index ? { ...x, creatorId: creator.id } : x)) }));
    pickFromFinder(creator, { created: true });
  }

  function addWord(value) {
    const word = cleanWord(value);
    setError(null);
    if (word.length < 2) return;
    if (word.length > 60) return setError('Keep a brand or topic under 60 characters.');
    if (hasWord(word)) return setDraft('');
    if (words.length >= limits.maxKeywords) return setError(`${limits.planName} includes ${count(limits.maxKeywords, 'brand or topic', 'brands and topics')}. Remove one to add another.`);
    setWords([...words, word]);
    setDraft('');
  }

  function submit() {
    const pendingWord = cleanWord(draft);
    const keywords = pendingWord.length >= 2 && !hasWord(pendingWord) && words.length < limits.maxKeywords ? [...words, pendingWord] : words;
    startTransition(async () => {
      const result = await finish({ useCase, creatorIds: [...picked], communities: [...subs], keywords });
      if (result?.error) setError(result.error);
    });
  }

  function next() {
    setStep(1);
    loadSuggestions();
  }

  const suggestedIds = new Set(suggested.list.map((s) => s.creatorId ?? s.existing?.id).filter(Boolean));
  const catalog = creatorList.filter((c) => !suggestedIds.has(c.id));

  return (
    <div className="ob">
      <ol className="ob-steps" aria-label="Setup steps">
        {STEPS.map((label, i) => (
          <li key={label} className={i === step ? 'on' : i < step ? 'done' : undefined} aria-current={i === step ? 'step' : undefined}>
            <span className="ob-num">{i < step ? <Icon name="check" size={13} /> : i + 1}</span>
            <span>{label}</span>
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <section className="ob-panel" aria-labelledby="ob-h-0">
          <p className="ob-hello">Welcome{firstName ? `, ${firstName}` : ''}.</p>
          <h1 id="ob-h-0">What brings you to Content-Story?</h1>
          <p className="ob-lede">We’ll suggest who to follow. You can change all of it later.</p>
          <div className="choices" role="radiogroup" aria-labelledby="ob-h-0">
            {useCases.map((u) => (
              <button key={u.id} type="button" role="radio" aria-checked={useCase === u.id} className={`choice-card${useCase === u.id ? ' on' : ''}`} onClick={() => setUseCase(u.id)}>
                <span className="choice-tick" aria-hidden="true">
                  <Icon name="check" size={13} />
                </span>
                <b>{u.label}</b>
                <span>{u.text}</span>
              </button>
            ))}
          </div>
          <label className="field ob-niche">
            <span>What do you cover?</span>
            <input
              value={niche}
              onChange={(e) => setNiche(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') next();
              }}
              placeholder={NICHE_EXAMPLES[useCase] ?? 'e.g. AI tools and startups'}
              maxLength={120}
              autoComplete="off"
            />
            <small>A few words is enough. We use it to suggest creators who post about it.</small>
          </label>
        </section>
      ) : null}

      {step === 1 ? (
        <section className="ob-panel" aria-labelledby="ob-h-1">
          <h1 id="ob-h-1">{useCase === 'agency' ? 'Who do you work with?' : 'Who do you want to follow?'}</h1>
          <p className="ob-lede">Type a name or paste one link and we find them on X, YouTube, LinkedIn, Instagram and TikTok. Got a list? Add several at once.</p>
          <CreatorFinder mode="pick" pickedIds={[...picked]} onPick={pickFromFinder} placeholder="A creator’s name, or any of their profile links" />
          <div className="ob-bar-inline">
            <span>
              {sourcesUsed} of {limits.maxSources} picked
            </span>
          </div>

          {suggested.status !== 'idle' ? (
            <>
              <h2 className="ob-h2">Suggested for “{cleanWord(niche)}”</h2>
              {suggested.status === 'loading' ? (
                <p className="ob-loading" role="status">
                  <Spinner /> Finding creators who post about it. This takes about a minute; pick others meanwhile.
                </p>
              ) : suggested.status === 'failed' ? (
                <p className="notice err">
                  {suggested.message}{' '}
                  <button
                    type="button"
                    className="linkbtn"
                    onClick={() => loadSuggestions({ again: true })}
                  >
                    Try again
                  </button>
                </p>
              ) : suggested.list.length ? (
                <div className="picks">
                  {suggested.list.map((s, i) => {
                    const id = s.creatorId ?? s.existing?.id;
                    const on = Boolean(id && picked.has(id));
                    return (
                      <button key={`${s.name}-${i}`} type="button" className={`pick${on ? ' on' : ''}`} aria-pressed={on} disabled={adding === i} onClick={() => pickSuggestion(s, i)}>
                        <Avatar name={s.name} size="md" />
                        <span className="pick-body">
                          <b>{s.name}</b>
                          <span className="marks">
                            {s.channels.map((c) => (
                              <PlatformMark key={c.platform} platform={c.platform} size="xs" />
                            ))}
                          </span>
                          <span className="pick-meta">{adding === i ? 'Adding…' : s.about || `On ${count(s.channels.length, 'platform')}`}</span>
                        </span>
                        <span className="pick-state" aria-hidden="true">
                          <Icon name={on ? 'check' : 'plus'} size={15} />
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="muted-note">No suggestions for that. Search for creators by name above.</p>
              )}
            </>
          ) : null}

          {catalog.length ? (
            <>
              <h2 className="ob-h2">Already on Content-Story</h2>
              <div className="picks">
                {catalog.map((c) => {
                  const on = picked.has(c.id);
                  return (
                    <button key={c.id} type="button" className={`pick${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggleCreator(c.id)}>
                      <Avatar name={c.name} size="md" />
                      <span className="pick-body">
                        <b>{c.name}</b>
                        <span className="marks">
                          {c.handles.map((h) => (
                            <PlatformMark key={h.platform} platform={h.platform} size="xs" />
                          ))}
                        </span>
                        <span className="pick-meta">
                          {c.story_ids?.length ? `In ${count(c.story_ids.length, 'story', 'stories')} this week` : c.posts ? `${count(c.posts, 'post')} this week` : 'Collected as soon as you finish'}
                        </span>
                      </span>
                      <span className="pick-state" aria-hidden="true">
                        <Icon name={on ? 'check' : 'plus'} size={15} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}

          {communities.length ? (
            <>
              <h2 className="ob-h2">Subreddits</h2>
              <div className="picks small">
                {communities.map((c) => {
                  const on = subs.has(c.name);
                  return (
                    <button key={c.name} type="button" className={`pick${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggleSub(c.name)}>
                      <Avatar name={c.name} kind="community" size="md" />
                      <span className="pick-body">
                        <b>{c.name}</b>
                        <span className="pick-meta">{c.story_ids.length ? `In ${count(c.story_ids.length, 'story', 'stories')} this week` : `${count(c.posts, 'thread')} this week`}</span>
                      </span>
                      <span className="pick-state" aria-hidden="true">
                        <Icon name={on ? 'check' : 'plus'} size={15} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}

          <h2 className="ob-h2">{useCase === 'brand' ? 'Your brand and competitors' : useCase === 'agency' ? 'Your clients’ brands' : 'Brands and topics'}</h2>
          <p className="muted-note">We search every platform for posts that mention them.</p>
          <form
            className="addword"
            onSubmit={(event) => {
              event.preventDefault();
              addWord(draft);
            }}
          >
            <label className="sr" htmlFor="ob-word">
              Brand or topic
            </label>
            <input
              id="ob-word"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={useCase === 'brand' ? 'e.g. boAt, Nothing, Apple' : 'e.g. OpenAI, iPhone, DeepSeek'}
              maxLength={60}
              autoComplete="off"
            />
            <button type="submit" className="btn ghost">
              Add
            </button>
          </form>
          {words.length ? (
            <ul className="wordchips" aria-label="Brands and topics you picked">
              {words.map((w) => (
                <li key={w}>
                  <span>{w}</span>
                  <button type="button" aria-label={`Remove ${w}`} onClick={() => setWords(words.filter((x) => x !== w))}>
                    <Icon name="close" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="ob-limit">
            {words.length} of {limits.maxKeywords} used
          </p>
          {topics.some((t) => !hasWord(t.name)) ? (
            <div className="suggest">
              {topics
                .filter((t) => !hasWord(t.name))
                .map((t) => (
                  <button key={t.name} type="button" className="suggest-chip" onClick={() => addWord(t.name)}>
                    <Icon name="plus" size={13} />
                    {t.name}
                    {t.story_ids.length ? <span className="suggest-n">{t.story_ids.length}</span> : null}
                  </button>
                ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <footer className="ob-foot">
        <div className="ob-foot-in">
          <p className="ob-covered" aria-live="polite">
            {step === 0 ? (
              <>Your stories are made only from who you follow, across six platforms.</>
            ) : (
              <>
                You picked <b>{sourcesUsed + words.length}</b>. Your stories are made from their posts.
              </>
            )}
          </p>
          <div className="ob-actions">
            {step > 0 ? (
              <button type="button" className="btn ghost" onClick={() => setStep(0)}>
                Back
              </button>
            ) : null}
            {step === 0 ? (
              <button type="button" className="btn primary" onClick={next}>
                {!useCase && !cleanWord(niche) ? 'Skip these questions' : 'Continue'}
                <Icon name="arrow" size={16} />
              </button>
            ) : (
              <button type="button" className="btn primary" disabled={pending || adding != null} onClick={submit}>
                {pending ? 'Setting up your stories…' : 'Show my stories'}
                {pending ? null : <Icon name="arrow" size={16} />}
              </button>
            )}
          </div>
        </div>
        {error ? (
          <p role="alert" className="notice err ob-error">
            {error}
          </p>
        ) : null}
      </footer>
    </div>
  );
}
