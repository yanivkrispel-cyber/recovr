import { useState, type CSSProperties } from 'react';

interface YouTubeFacadeProps {
  youtubeId: string;
  title: string;
  height?: number;
  style?: CSSProperties;
  /** Trim window (T-31): play from / stop at these seconds. */
  startSec?: number | null;
  endSec?: number | null;
}

// Click-to-load embed: a live <iframe src="youtube.../embed"> pulls in ~1MB of
// third-party JS and several connections on mount, which is wasted cost for
// every viewer who never presses play. This renders just a cacheable static
// thumbnail (no API key needed) until the viewer taps it, and only then swaps
// in the real iframe — youtube-nocookie.com so no tracking cookie is set
// before that tap either.
export function YouTubeFacade({ youtubeId, title, height = 200, style, startSec, endSec }: YouTubeFacadeProps) {
  const [loaded, setLoaded] = useState(false);

  if (loaded) {
    return (
      <iframe
        src={`https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=1&rel=0${startSec ? `&start=${startSec}` : ''}${endSec ? `&end=${endSec}` : ''}`}
        title={title}
        width="100%"
        height={height}
        style={{ border: 'none', borderRadius: 'var(--radius-card)', display: 'block', ...style }}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setLoaded(true)}
      aria-label={`${title} — נגן וידאו · Play video`}
      style={{
        position: 'relative',
        width: '100%',
        height,
        border: 'none',
        borderRadius: 'var(--radius-card)',
        overflow: 'hidden',
        cursor: 'pointer',
        padding: 0,
        background: `#000 url(https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg) center / cover no-repeat`,
        ...style,
      }}
    >
      <span
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0,0,0,0.25)',
        }}
      >
        <span
          style={{
            width: 52,
            height: 52,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.92)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="#1a1a1a">
            <path d="M8 5v14l11-7z" />
          </svg>
        </span>
      </span>
    </button>
  );
}
