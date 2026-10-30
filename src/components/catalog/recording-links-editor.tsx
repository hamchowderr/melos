'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveRecording } from '@/app/catalog/recording-actions';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { LINK_TYPES, type RecordingLinkDTO } from '@/lib/dto/catalog';
import { words } from '@/lib/words';

type LinkType = (typeof LINK_TYPES)[number];
type Row = { key: number; url: string; linkType: LinkType; label: string };

const REFUSED: Record<string, string> = {
  FORBIDDEN: 'Your workspace role does not allow this change.',
  NOT_FOUND: 'This recording no longer exists. Reload the page.',
  VALIDATION: 'Check each link: a full https:// URL, and one primary link at most.',
};

let nextKey = 0;
const rowsOf = (links: RecordingLinkDTO[]): Row[] =>
  links.map(({ url, linkType, label }) => ({
    key: nextKey++,
    url,
    linkType: (LINK_TYPES as readonly string[]).includes(linkType)
      ? (linkType as LinkType)
      : 'other',
    label: label ?? '',
  }));

type Props = { recordingId: string; title: string; links: RecordingLinkDTO[] };

/**
 * Edits a recording's links (CAT-005) in a Dialog: a URL, a type and a label per link, and a radio
 * for the primary one, which the song page's player opens (D-8). Save replaces the whole set.
 */
export function RecordingLinksEditor({ recordingId, title, links }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(() => rowsOf(links));
  const [primary, setPrimary] = useState(
    () => rows[links.findIndex((l) => l.isPrimary)]?.key ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const change = (key: number, patch: Partial<Row>) =>
    setRows(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const save = () =>
    startTransition(async () => {
      setError(null);
      const set = rows.map(({ key, url, linkType, label }) => ({
        ...{ url: url.trim(), linkType, label: label.trim() || null },
        isPrimary: key === primary,
      }));
      const result = await saveRecording(recordingId, { links: set }).catch(() => null);
      if (!result?.ok) return setError((result && REFUSED[result.code]) || 'Could not save.');
      setOpen(false);
      router.refresh();
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" className="self-start" />}>
        Edit links
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{`Links for ${title}`}</DialogTitle>
          </DialogHeader>
          {rows.map((row, i) => (
            <fieldset key={row.key} className="flex flex-col gap-2 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">{`Link ${i + 1}`}</legend>
              <Input
                aria-label={`Link ${i + 1} URL`}
                type="url"
                required
                placeholder="https://"
                value={row.url}
                onChange={(event) => change(row.key, { url: event.target.value })}
              />
              <div className="flex flex-wrap items-center gap-2">
                <NativeSelect
                  aria-label={`Link ${i + 1} type`}
                  value={row.linkType}
                  onChange={(event) =>
                    change(row.key, { linkType: event.target.value as LinkType })
                  }
                >
                  {LINK_TYPES.map((type) => (
                    <NativeSelectOption key={type} value={type}>
                      {words(type)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <Input
                  aria-label={`Link ${i + 1} label`}
                  className="w-40"
                  placeholder="Label"
                  value={row.label}
                  onChange={(event) => change(row.key, { label: event.target.value })}
                />
                <label className="inline-flex items-center gap-1.5 text-sm">
                  <input
                    type="radio"
                    name={`primary-${recordingId}`}
                    checked={primary === row.key}
                    onChange={() => setPrimary(row.key)}
                  />
                  Primary
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => setRows(rows.filter(({ key }) => key !== row.key))}
                >
                  {`Remove link ${i + 1}`}
                </Button>
              </div>
            </fieldset>
          ))}
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() =>
              setRows([...rows, { key: nextKey++, url: '', linkType: 'private_player', label: '' }])
            }
          >
            Add link
          </Button>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
