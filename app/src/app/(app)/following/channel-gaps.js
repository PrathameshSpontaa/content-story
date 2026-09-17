'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PLATFORM_NAMES } from '../../../../lib/format.js';
import { addChannelsAction } from '../../actions/creators.js';
import { Spinner, askFinder } from '../../components/creator-finder.js';
import PlatformMark from '../../components/platform-mark.js';

const names = (list) => (list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);

// Creators followed on only some platforms, never checked for the rest: the finder looks once, in the
// background, and anything new is offered with one tap. Nothing is added without that tap.
export default function ChannelGaps({ creators }) {
  const router = useRouter();
  const [state, setState] = useState(() => Object.fromEntries(creators.map((c) => [c.creatorId, { status: 'waiting' }])));
  const patch = (id, p) => setState((s) => ({ ...s, [id]: { ...s[id], ...p } }));

  useEffect(() => {
    let stopped = false;
    (async () => {
      for (const c of creators.slice(0, 5)) {
        if (stopped) return;
        patch(c.creatorId, { status: 'checking' });
        try {
          const data = await askFinder({ name: c.name, link: c.handles[0]?.url ?? '', creatorId: c.creatorId });
          const have = new Set(c.handles.map((h) => h.platform));
          const fresh = (data.channels ?? []).filter((ch) => !have.has(ch.platform));
          patch(c.creatorId, fresh.length ? { status: 'found', channels: fresh, on: Object.fromEntries(fresh.map((ch) => [ch.platform, true])) } : { status: 'none' });
        } catch {
          patch(c.creatorId, { status: 'none' });
        }
      }
    })();
    return () => {
      stopped = true;
    };
    // Runs once per page load; the finder marks each creator as checked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function add(c) {
    const s = state[c.creatorId];
    const chosen = s.channels.filter((ch) => s.on[ch.platform]);
    if (!chosen.length) return patch(c.creatorId, { status: 'none' });
    patch(c.creatorId, { status: 'adding' });
    const res = await addChannelsAction(c.creatorId, chosen.map((ch) => ({ platform: ch.platform, input: ch.url })));
    if (res.error) return patch(c.creatorId, { status: 'found', error: res.error });
    patch(c.creatorId, { status: 'added', added: res.added, collecting: res.collecting });
    router.refresh();
  }

  const visible = creators.filter((c) => ['checking', 'found', 'adding', 'added'].includes(state[c.creatorId]?.status));
  if (!visible.length) return null;

  return (
    <section className="gaps" aria-label="More channels for creators you follow">
      {visible.map((c) => {
        const s = state[c.creatorId];
        if (s.status === 'checking') {
          return (
            <p key={c.creatorId} className="gap muted-note" role="status">
              <Spinner /> Checking where else {c.name} posts…
            </p>
          );
        }
        if (s.status === 'added') {
          return (
            <p key={c.creatorId} className="gap notice ok" role="status">
              Added {s.added === 1 ? '1 channel' : `${s.added} channels`} for {c.name}.{s.collecting ? ' Collecting their posts now.' : ''}
            </p>
          );
        }
        const chosen = s.channels.filter((ch) => s.on[ch.platform]).length;
        return (
          <div key={c.creatorId} className="gap notice info">
            <p>
              <b>{c.name}</b> also posts on {names(s.channels.map((ch) => PLATFORM_NAMES[ch.platform]))}. You only follow them on {names(c.handles.map((h) => PLATFORM_NAMES[h.platform]))}.
            </p>
            <ul className="gap-channels">
              {s.channels.map((ch) => (
                <li key={ch.platform}>
                  <label className="check">
                    <input type="checkbox" checked={s.on[ch.platform]} onChange={(e) => patch(c.creatorId, { on: { ...s.on, [ch.platform]: e.target.checked } })} />
                    <PlatformMark platform={ch.platform} size="xs" />
                  </label>
                  <a href={ch.url} target="_blank" rel="noopener noreferrer">
                    {ch.handle}
                  </a>
                </li>
              ))}
            </ul>
            {s.error ? <p className="field-error">{s.error}</p> : null}
            <div className="gap-actions">
              <button type="button" className="btn ghost sm" onClick={() => patch(c.creatorId, { status: 'none' })}>
                Not them
              </button>
              <button type="button" className="btn primary sm" disabled={s.status === 'adding' || !chosen} onClick={() => add(c)}>
                {s.status === 'adding' ? 'Adding…' : `Add ${chosen === 1 ? '1 channel' : `${chosen} channels`}`}
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
