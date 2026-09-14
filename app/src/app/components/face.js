'use client';

import { useEffect, useRef, useState } from 'react';
import { PLATFORM_NAMES } from '../../../lib/format.js';
import Avatar from './avatar.js';
import PlatformMark from './platform-mark.js';

// A creator's profile photo from whichever channel gave us one, marked with that channel.
// Initials stand in when there's no photo or it won't load (some channels' photo links expire).
// `badge` false drops the channel mark, for when something around the face already says where it's from.
export default function Face({ name, kind = 'creator', photo, size = 'md', badge = true }) {
  const [failed, setFailed] = useState(false);
  const img = useRef(null);

  useEffect(() => {
    // A photo that failed before hydration never fires onError, so check once mounted.
    if (img.current?.complete && img.current.naturalWidth === 0) setFailed(true);
  }, [photo?.url]);

  if (kind !== 'creator' || !photo?.url || failed) return <Avatar name={name} kind={kind} size={size} />;
  return (
    <span className={`face ${size}`} title={`Photo from ${PLATFORM_NAMES[photo.platform] ?? photo.platform}`}>
      <img ref={img} src={photo.url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      {size === 'xs' || !badge ? null : (
        <span className="face-badge">
          <PlatformMark platform={photo.platform} size="xs" />
        </span>
      )}
    </span>
  );
}
