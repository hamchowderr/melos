'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { finishAudioUpload, startAudioUpload } from '@/app/catalog/asset-actions';
import { Input } from '@/components/ui/input';

const REFUSED: Record<string, string> = {
  FORBIDDEN: 'Your workspace role does not allow uploads.',
  VALIDATION: 'Choose an MP3, WAV, FLAC, AAC or M4A file of 200 MB or less.',
  NOT_FOUND: 'The upload did not arrive. Try again.',
};

/**
 * Uploads audio to a recording (§7.5, CAT-005): AssetService signs a PUT, the browser sends the
 * file with its Content-Type, then the server registers the asset and attaches it.
 */
export function AssetUpload({ recordingId, title }: { recordingId: string; title: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const upload = (file: File) =>
    startTransition(async () => {
      setError(null);
      const started = await startAudioUpload(file.name, file.type).catch(() => null);
      if (!started?.ok) return setError((started && REFUSED[started.code]) || 'Could not upload.');
      const { assetId, url, contentType } = started.ticket;
      const put = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': contentType },
        body: file,
      }).catch(() => null);
      if (!put?.ok) return setError('Could not upload.');
      const done = await finishAudioUpload(recordingId, assetId, file.name).catch(() => null);
      if (!done?.ok) return setError((done && REFUSED[done.code]) || 'Could not upload.');
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium" htmlFor={`audio-${recordingId}`}>
        {`Upload audio for ${title}`}
      </label>
      <Input
        id={`audio-${recordingId}`}
        type="file"
        accept="audio/*"
        disabled={pending}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) upload(file);
          event.target.value = '';
        }}
      />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
