'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { createContactPitch } from '@/app/people/pitch-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import type { PitchItemInput } from '@/lib/dto/pitches';

export type PitchableSong = { key: string; title: string; item: PitchItemInput };

/** Create pitch on a contact (§2.3 ContactGrid): one song and a subject; the cell starts as a draft. */
export function CreatePitch({ contactId, songs }: { contactId: string; songs: PitchableSong[] }) {
  const router = useRouter();
  const [song, setSong] = useState('');
  const [subject, setSubject] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, start] = useTransition();
  const create = () => {
    const chosen = songs.find((s) => s.key === song);
    if (!chosen) return;
    start(async () => {
      const result = await createContactPitch({ contactId, items: [chosen.item], subject });
      if (!result.ok) return setError(`Not created (${result.code}).`);
      setSong('');
      setSubject('');
      setError(null);
      router.refresh();
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <NativeSelect
        aria-label="Song to Pitch"
        value={song}
        onChange={(event) => setSong(event.target.value)}
      >
        <NativeSelectOption value="">Pick a song…</NativeSelectOption>
        {songs.map((s) => (
          <NativeSelectOption key={s.key} value={s.key}>
            {s.title}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <Input
        aria-label="Pitch Subject"
        placeholder="Subject (optional)"
        className="h-8 w-56"
        value={subject}
        onChange={(event) => setSubject(event.target.value)}
      />
      <Button size="sm" disabled={!song || saving} onClick={create}>
        Create Pitch
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
