import { z } from 'zod';
import {
  FOCUSED_ENTITY_CONTEXT,
  type FocusedEntity,
  focusedEntitySchema,
} from '../lib/agent/contract';

type ContextReader = { get(key: string): unknown };

const agUiContextSchema = z.object({
  context: z.array(z.object({ description: z.string(), value: z.string() })),
});

/**
 * The focused entity the chat sent in AG-UI `input.context` (U-04), which @ag-ui/mastra keeps
 * under the `ag-ui` request context key. Null when absent or malformed: only a type and a
 * well-formed id get through, never free text.
 */
export function readFocusedEntity(requestContext: ContextReader | undefined): FocusedEntity | null {
  const agUi = agUiContextSchema.safeParse(requestContext?.get('ag-ui'));
  if (!agUi.success) return null;
  const entry = agUi.data.context.findLast((item) => item.description === FOCUSED_ENTITY_CONTEXT);
  if (!entry) return null;
  try {
    const parsed = focusedEntitySchema.safeParse(JSON.parse(entry.value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The instruction line naming the focused entity, or null without one. */
export function focusInstruction(requestContext: ContextReader | undefined): string | null {
  const focus = readFocusedEntity(requestContext);
  return focus
    ? `The focused entity is ${focus.entityType} ${focus.entityId}: "this", "it" or "that song" means it unless the user names another.`
    : null;
}
