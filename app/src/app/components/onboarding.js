'use client';

import { useEffect, useState, useTransition } from 'react';
import Avatar from './avatar.js';
import CreatorFinder from './creator-finder.js';
import Icon from './icons.js';
import PlatformMark from './platform-mark.js';

const STEPS = ['About you', 'Creators', 'Brands and topics'];
const count = (n, one, many = `${one}s`) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
const cleanWord = (value) => value.trim().replace(/\s+/g, ' ');

// First run: who you are, who to follow, which brands to watch. Nothing is saved until the end.
// Stories are made only from the picks, so the footer says how many there are.
export default function Onboarding({ firstName, useCases, creators, communities, topics, limits, initialUseCase, finish }) {
  const [step, setStep] = useState(0);
  const [creatorList, setCreatorList] = useState(creators);
  const [useCase, setUseCase] = useState(initialUseCase ?? null);
  const [picked, setPicked] = useState(() => new Set(creators.filter((c) => c.target_id).map((c) => c.id)));
  const [subs, setSubs] = useState(() => new Set(communities.filter((c) => c.target_id).map((c) => c.name)));
  const [words, setWords] = useState(() => topics.filter((t) => t.target_id).map((t) => t.name));
  const [draft, setDraft] = useState('');
  const [error, setError] = useState(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    window.scrollTo({ top: 0 });
    setError(null);
  }, [step]);

  const sourcesUsed = picked.size + subs.size;
  const hasWord = (name) => words.some((w) => w.toLowerCase() === name.toLowerCase());

  const sourceLimitMessage = `${limits.planName} includes ${count(limits.maxSources, 'creator or subreddit', 'creators and subreddits')}. Unpick one to add another.`;

  // Creators and subreddits share one limit.
  function toggleIn(set, setSet, key) {
    setError(null);
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else if (sourcesUsed >= limits.maxSources) return setError(sourceLimitMessage);
    else next.add(key);
    setSet(next);
  }
  const toggleCreator = (id) => toggleIn(picked, setPicked, id);

  // Someone found or added through the search box joins the list; a new creator is picked straight away.
  function pickFromFinder(creator, { created = false } = {}) {
    setCreatorList((list) => (list.some((c) => c.id === creator.id) ? list : [creator, ...list]));
    if (created && picked.has(creator.id)) return;
    toggleCreator(creator.id);
  }
  const toggleSub = (name) => toggleIn(subs, setSubs, name);

  const allCreatorsPicked = creatorList.length > 0 && creatorList.every((c) => picked.has(c.id));
  function pickAllCreators() {
    setError(null);
    if (allCreatorsPicked) {
      setPicked(new Set());
      return;
    }
    const next = new Set(picked);
    for (const c of creatorList) {
      if (next.size + subs.size >= limits.maxSources) break;
      next.add(c.id);
    }
    setPicked(next);
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
          <p className="ob-lede">We’ll suggest what to follow. You can change all of it later.</p>
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
        </section>
      ) : null}

      {step === 1 ? (
        <section className="ob-panel" aria-labelledby="ob-h-1">
          <h1 id="ob-h-1">{useCase === 'agency' ? 'Follow the creators you work with' : 'Follow creators you care about'}</h1>
          <p className="ob-lede">We already read these creators’ posts on X, YouTube, LinkedIn, Instagram and TikTok, and the comments under them. Pick any, or find someone else.</p>
          <CreatorFinder mode="pick" pickedIds={[...picked]} onPick={pickFromFinder} placeholder="Someone else? Search by name or paste their profile link" />
          <div className="ob-bar-inline">
            <span>
              {sourcesUsed} of {limits.maxSources} picked
            </span>
            <button type="button" className="linkbtn" onClick={pickAllCreators}>
              {allCreatorsPicked ? 'Clear creators' : 'Pick all creators'}
            </button>
          </div>
          <div className="picks">
            {creatorList.map((c) => {
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
                      {c.story_ids.length ? `In ${count(c.story_ids.length, 'story', 'stories')} this week` : c.posts ? `${count(c.posts, 'post')} this week` : 'New · collected after setup'}
                    </span>
                  </span>
                  <span className="pick-state" aria-hidden="true">
                    <Icon name={on ? 'check' : 'plus'} size={15} />
                  </span>
                </button>
              );
            })}
          </div>

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
        </section>
      ) : null}

      {step === 2 ? (
        <section className="ob-panel" aria-labelledby="ob-h-2">
          <h1 id="ob-h-2">{useCase === 'brand' ? 'Add your brand and competitors' : useCase === 'agency' ? 'Add your clients’ brands' : 'Brands and topics to watch'}</h1>
          <p className="ob-lede">We flag every story that mentions them, on any platform.</p>
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
            <>
              <h2 className="ob-h2">In this week’s stories</h2>
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
            </>
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
              <button type="button" className="btn ghost" onClick={() => setStep(step - 1)}>
                Back
              </button>
            ) : null}
            {step < STEPS.length - 1 ? (
              <button type="button" className="btn primary" onClick={() => setStep(step + 1)}>
                {step === 0 && !useCase ? 'Skip this question' : 'Continue'}
                <Icon name="arrow" size={16} />
              </button>
            ) : (
              <button type="button" className="btn primary" disabled={pending} onClick={submit}>
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
