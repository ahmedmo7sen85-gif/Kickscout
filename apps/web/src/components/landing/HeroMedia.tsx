'use client';

import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '@/lib/hooks';
import { HERO_CLIP, promoPosterUrl, promoVideoUrl } from '@/lib/promo';
import { PitchPlaceholder } from './PromoClip';

/**
 * Landing hero film: always muted (no sound control is offered), looping, inline, with the poster
 * as fallback. It autoplays only where the browser allows and the user has not asked for reduced
 * motion.
 */
export function HeroMedia({ label }: { label: string }) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLVideoElement>(null);
  const [posterOk, setPosterOk] = useState(true);
  const [posterLoaded, setPosterLoaded] = useState(false);
  const [videoOk, setVideoOk] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.muted = true;
    if (reduced) v.pause(); else v.play().catch(() => {});
  }, [reduced, videoOk]);

  return (
    <div className="hero__media" data-testid="hero-media">
      <PitchPlaceholder wide />
      {posterOk ? <img ref={(el) => { if (el?.complete && el.naturalWidth > 0) setPosterLoaded(true); }} src={promoPosterUrl(HERO_CLIP.stem)} alt="" onLoad={() => setPosterLoaded(true)} onError={() => setPosterOk(false)} hidden={videoOk && !reduced} style={{ opacity: posterLoaded ? 1 : 0 }} /> : null}
      {!failed ? (
        <video
          ref={ref}
          src={promoVideoUrl(HERO_CLIP.stem)}
          poster={posterOk ? promoPosterUrl(HERO_CLIP.stem) : undefined}
          muted
          loop
          playsInline
          preload={reduced ? 'none' : 'auto'}
          aria-label={label}
          hidden={!videoOk || reduced}
          onLoadedData={() => setVideoOk(true)}
          onError={() => setFailed(true)}
        />
      ) : null}
    </div>
  );
}
