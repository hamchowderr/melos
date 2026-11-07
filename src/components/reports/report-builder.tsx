'use client';

import { ArrowUp, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { previewReportText, saveReportSnapshot } from '@/app/reports/actions';
import { Button } from '@/components/ui/button';
import { GridFrame } from '@/components/ui/grid-frame';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { SongListItem } from '@/lib/dto/catalog';
import {
  type GeneratedReportSummary,
  MAX_REPORT_ITEMS,
  type ReportItemInput,
  type ReportSection,
  type ReportSectionId,
  type ReportTemplateSummary,
} from '@/lib/dto/reports';
import { cn } from '@/lib/utils';

type Props = {
  songs: SongListItem[];
  templates: ReportTemplateSummary[];
  snapshots: GeneratedReportSummary[];
  generates: boolean;
};

type Choice = { key: string; title: string; item: ReportItemInput };

const SECTION_LABELS: Record<ReportSectionId, string> = {
  ...{ core: 'Core', rights: 'Rights', creators: 'Creators', composition: 'Composition' },
  ...{ recording: 'Recording', metadata: 'Metadata', listen: 'Listen', licensing: 'Licensing' },
  lyrics: 'Lyrics',
};

/** A song is chosen by its composition, or by its recording when it has none (§3.7). */
const choiceOf = (song: SongListItem): Choice | null => {
  if (song.compositionId)
    return {
      key: song.compositionId,
      title: song.title,
      item: { compositionId: song.compositionId },
    };
  if (song.primaryRecordingId)
    return {
      ...{ key: song.primaryRecordingId, title: song.title },
      item: { recordingId: song.primaryRecordingId },
    };
  return null;
};

const songCount = (count: number) => (count === 1 ? '1 song' : `${count} songs`);

/** ReportPreview (§2.3): songs in order, a template, section toggles, live text and snapshots. */
export function ReportBuilder({ songs, templates, snapshots, generates }: Props) {
  const router = useRouter();
  const choices = songs.flatMap((song) => choiceOf(song) ?? []);
  const [templateId, setTemplateId] = useState(templates[0]?.templateId ?? '');
  const [sections, setSections] = useState<ReportSection[]>(templates[0]?.sections ?? []);
  const [chosen, setChosen] = useState<Choice[]>([]);
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const [open, setOpen] = useState<GeneratedReportSummary | null>(null);
  const latest = useRef(0);
  const names = new Map(templates.map((t) => [t.templateId, t.name]));

  const input = () => ({
    templateId,
    items: chosen.map((choice) => choice.item),
    sections: Object.fromEntries(sections.map((s) => [s.id, s.enabled])),
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: input() reads exactly these.
  useEffect(() => {
    const request = ++latest.current;
    if (chosen.length === 0) return setText('');
    previewReportText(input()).then((result) => {
      if (request !== latest.current) return;
      setText(result.ok ? result.value.text : '');
      setNote(result.ok ? null : `No preview (${result.code}).`);
    });
  }, [templateId, sections, chosen]);

  const pickTemplate = (id: string) => {
    setTemplateId(id);
    setSections(templates.find((t) => t.templateId === id)?.sections ?? []);
  };
  const toggle = (id: ReportSectionId) =>
    setSections((all) => all.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
  const add = (key: string) => {
    const choice = choices.find((c) => c.key === key);
    if (choice) setChosen((all) => [...all, choice]);
  };
  const moveUp = (index: number) =>
    setChosen((all) => [
      ...all.slice(0, index - 1),
      all[index],
      all[index - 1],
      ...all.slice(index + 1),
    ]);
  const remove = (index: number) => setChosen((all) => all.filter((_, i) => i !== index));
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setNote('Copied.');
  };
  const save = () =>
    startSave(async () => {
      const result = await saveReportSnapshot(input());
      setNote(result.ok ? 'Snapshot saved.' : `Not saved (${result.code}).`);
      if (result.ok) router.refresh();
    });
  const left = choices.filter((c) => !chosen.some((picked) => picked.key === c.key));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <nav aria-label="Report Template" className="flex flex-wrap gap-1">
            {templates.map((t) => (
              <button
                key={t.templateId}
                type="button"
                aria-pressed={t.templateId === templateId}
                onClick={() => pickTemplate(t.templateId)}
                className={cn(
                  'rounded-full px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted',
                  t.templateId === templateId && 'bg-muted font-medium text-foreground',
                )}
              >
                {t.name}
              </button>
            ))}
          </nav>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">Sections</legend>
            <div className="grid grid-cols-3 gap-x-3 gap-y-1">
              {sections.map((s) => (
                <label key={s.id} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={s.enabled} onChange={() => toggle(s.id)} />
                  {SECTION_LABELS[s.id]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Songs, in report order
            </span>
            <ol aria-label="Report Songs" className="flex flex-col gap-0.5">
              {chosen.map((choice, index) => (
                <li
                  key={choice.key}
                  className="flex h-8 items-center gap-2 rounded-md bg-muted/50 pr-1 pl-2.5 text-sm"
                >
                  <span className="w-4 text-xs text-muted-foreground tabular-nums">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{choice.title}</span>
                  {index > 0 ? (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Move ${choice.title} up`}
                      onClick={() => moveUp(index)}
                    >
                      <ArrowUp />
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${choice.title}`}
                    onClick={() => remove(index)}
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ol>
            {chosen.length < MAX_REPORT_ITEMS && left.length > 0 ? (
              <NativeSelect
                aria-label="Add a Song"
                value=""
                onChange={(event) => add(event.target.value)}
              >
                <NativeSelectOption value="">Add a Song…</NativeSelectOption>
                {left.map((c) => (
                  <NativeSelectOption key={c.key} value={c.key}>
                    {c.title}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            ) : null}
          </div>
        </div>
        <section
          aria-label="Report Text"
          className="flex min-h-64 flex-col gap-2 rounded-lg bg-muted/40 p-3"
        >
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {note ?? songCount(chosen.length)}
            </span>
            <div className="ml-auto flex gap-1.5">
              <Button size="sm" variant="ghost" disabled={!text} onClick={copy}>
                Copy Text
              </Button>
              {generates ? (
                <Button size="sm" disabled={!text || saving} onClick={save}>
                  Save Snapshot
                </Button>
              ) : null}
            </div>
          </div>
          <pre className="text-sm leading-relaxed whitespace-pre-wrap">
            {text || 'Add a song to see the report.'}
          </pre>
        </section>
      </div>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-sm font-medium">Saved Snapshots</h2>
        <GridFrame>
          <Table aria-label="Saved Snapshots">
            <TableHeader>
              <TableRow>
                <TableHead>Saved</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Songs</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshots.map((s) => (
                <TableRow
                  key={s.reportId}
                  aria-label={`Snapshot ${s.generatedAt.slice(0, 16).replace('T', ' ')}`}
                  className="cursor-pointer"
                  onClick={() => setOpen(s)}
                >
                  <TableCell className="tabular-nums">
                    {s.generatedAt.slice(0, 16).replace('T', ' ')}
                  </TableCell>
                  <TableCell>{names.get(s.templateId) ?? 'Template'}</TableCell>
                  <TableCell>{songCount(s.songCount)}</TableCell>
                </TableRow>
              ))}
              {snapshots.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-muted-foreground">
                    No snapshots yet.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </GridFrame>
      </div>
      <Sheet open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{open ? (names.get(open.templateId) ?? 'Snapshot') : ''}</SheetTitle>
          </SheetHeader>
          <pre className="px-4 pb-4 text-sm leading-relaxed whitespace-pre-wrap">{open?.text}</pre>
        </SheetContent>
      </Sheet>
    </div>
  );
}
