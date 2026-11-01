'use client';

import { useAgentContext } from '@copilotkit/react-core/v2';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { FOCUSED_ENTITY_CONTEXT, type FocusedEntity } from '@/lib/agent/contract';

const SetFocusContext = createContext<(focus: FocusedEntity) => void>(() => {});

/**
 * Sends the entity the chat shows last as AG-UI `input.context` (U-04): renderers set it, and
 * every run carries it, so "this song" resolves to it (§3.7).
 */
export function FocusProvider({ children }: { children: ReactNode }) {
  const [focus, setFocus] = useState<FocusedEntity | null>(null);
  useAgentContext({ description: FOCUSED_ENTITY_CONTEXT, value: focus });
  return <SetFocusContext.Provider value={setFocus}>{children}</SetFocusContext.Provider>;
}

/** Wraps a rendered result whose entity becomes the focused one when it mounts. */
export function FocusOn({
  entity,
  children,
}: {
  entity: FocusedEntity | null;
  children: ReactNode;
}) {
  const setFocus = useContext(SetFocusContext);
  const { entityType, entityId } = entity ?? {};
  useEffect(() => {
    if (entityType && entityId) setFocus({ entityType, entityId });
  }, [setFocus, entityType, entityId]);
  return children;
}
