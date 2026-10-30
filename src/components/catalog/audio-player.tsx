'use client';

import { useEffect, useRef, useState } from 'react';
import { signAudio } from '@/app/catalog/asset-actions';

type Props = {
  assetId: string;
  /** The URL the page signed (P-35: 3600 s for audio). */
  url: string;
  /** Where playback starts, in milliseconds (CAT-004). */
  previewStartMs: number | null;
  label: string;
};

/**
 * Plays a recording's uploaded audio (§2.3 AudioPlayer, CAT-005) from its signed URL, starting at
 * the preview start. A load error, such as an expired URL answering 403, re-signs once (P-35); a
 * second failure stays an error. External player links stay links (D-8).
 */
export function AudioPlayer({ assetId, url, previewStartMs, label }: Props) {
  // A re-sign remounts the element under a new key, so it loads even when the URL is unchanged.
  const [source, setSource] = useState({ src: url, attempt: 0 });
  const [failed, setFailed] = useState(false);
  const resigned = useRef(false);
  const audio = useRef<HTMLAudioElement>(null);
  const retry = async () => {
    if (resigned.current) return setFailed(true);
    resigned.current = true;
    const fresh = await signAudio(assetId).catch(() => null);
    if (fresh) setSource({ src: fresh, attempt: 1 });
    else setFailed(true);
  };
  const seek = () => {
    if (audio.current && previewStartMs) audio.current.currentTime = previewStartMs / 1000;
  };
  // Metadata, or a load error, can arrive before hydration attaches the handlers, so check both
  // on mount too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per mount.
  useEffect(() => {
    if (audio.current?.error) retry();
    else if ((audio.current?.readyState ?? 0) >= 1) seek();
  }, []);

  return (
    <div className="flex flex-col gap-1">
      {/* biome-ignore lint/a11y/useMediaCaption: uploaded music has no captions to offer. */}
      <audio
        aria-label={label}
        controls
        preload="metadata"
        key={source.attempt}
        src={source.src}
        className="w-full"
        ref={audio}
        onLoadedMetadata={seek}
        onError={retry}
      />
      {failed ? <p className="text-sm text-destructive">The audio could not be loaded.</p> : null}
    </div>
  );
}
