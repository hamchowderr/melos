'use client';

import { type FormEvent, useState } from 'react';
import { saveWorkspaceType } from '@/app/settings/workspace-type-action';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldError } from '@/components/ui/field';
import { WORKSPACE_TYPE_INFO, type WorkspaceType } from '@/lib/workspace-type';
import { WorkspaceTypePicker } from './workspace-type-picker';

type Props = { workspaceType: WorkspaceType; canEdit: boolean };

/** ONB-002: the workspace type in /settings, editable by owners and admins. */
export function WorkspaceTypePanel({ workspaceType, canEdit }: Props) {
  const [saved, setSaved] = useState(workspaceType);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const chosen = String(new FormData(event.currentTarget).get('workspaceType') ?? '');
    setPending(true);
    setError(null);
    const result = await saveWorkspaceType(chosen).catch(() => null);
    setPending(false);
    if (!result?.ok) {
      setError(
        result?.code === 'FORBIDDEN'
          ? 'Only owners and admins can change this.'
          : 'Could not save the workspace type.',
      );
      return;
    }
    setSaved(chosen as WorkspaceType);
  }

  return (
    <Card className="w-full max-w-2xl" data-testid="workspace-type-panel">
      <CardHeader>
        <CardTitle>
          <h2>Workspace type</h2>
        </CardTitle>
        <CardDescription>
          Sets the getting-started checklist on Today. Currently {WORKSPACE_TYPE_INFO[saved].label}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <WorkspaceTypePicker defaultValue={saved} disabled={!canEdit || pending} />
          <FieldError>{error}</FieldError>
          {canEdit ? (
            <Button type="submit" className="self-start" disabled={pending}>
              {pending ? 'Saving...' : 'Save type'}
            </Button>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
