'use client';

import { useState, useTransition } from 'react';
import { saveMessageDraft } from '@/app/outreach/draft-actions';
import { ToolCard } from '@/components/chat/tool-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { MessageDraftDTO } from '@/lib/dto/outreach';

const addresses = (list: MessageDraftDTO['to']) => list.map(({ address }) => address).join(', ');

/**
 * MessageDraftCard (§3.3, OUT-001, OUT-004): an outbound draft with its recipients, an editable
 * subject and body saved through updateMessageDraft, and the facts it was drafted from beside it.
 */
export function MessageDraftCard({ draft: initial }: { draft: MessageDraftDTO }) {
  const [draft, setDraft] = useState(initial);
  const [subject, setSubject] = useState(initial.subject);
  const [bodyText, setBodyText] = useState(initial.bodyText);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const changed = subject !== draft.subject || bodyText !== draft.bodyText;
  const save = () =>
    startSaving(async () => {
      const saved = await saveMessageDraft({ messageId: draft.messageId, subject, bodyText });
      if (saved.ok) setDraft(saved.draft);
      setNotice(saved.ok ? 'Draft saved.' : `Not saved (${saved.code}).`);
    });
  const { sourceFacts } = draft;
  return (
    <ToolCard title="Email draft">
      <div className="flex flex-col gap-2 px-4 pb-3">
        <p className="text-xs text-muted-foreground">
          To {addresses(draft.to) || 'no one yet'}
          {draft.cc.length ? ` · cc ${addresses(draft.cc)}` : ''}
          {draft.bcc.length ? ` · bcc ${addresses(draft.bcc)}` : ''}
        </p>
        <Input
          aria-label="Subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
        <Textarea
          aria-label="Body"
          value={bodyText}
          onChange={(event) => setBodyText(event.target.value)}
          className="min-h-32"
        />
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={!changed || saving} onClick={save}>
            {saving ? 'Saving...' : 'Save draft'}
          </Button>
          {notice ? (
            <span role="status" className="text-xs text-muted-foreground">
              {notice}
            </span>
          ) : null}
        </div>
        <aside aria-label="Drafted from" className="rounded-lg bg-muted/40 px-3 py-2 text-xs">
          <p className="font-medium">For {sourceFacts.contactName}</p>
          <ul className="mt-1 flex flex-col gap-0.5 text-muted-foreground">
            {sourceFacts.items.map((item) => (
              <li key={item.itemId}>
                {item.title}
                {item.primaryLink ? ` · ${item.primaryLink}` : ''}
              </li>
            ))}
          </ul>
          {sourceFacts.generatedReportId ? (
            <p className="mt-1 text-muted-foreground">Report attached</p>
          ) : null}
        </aside>
      </div>
    </ToolCard>
  );
}
