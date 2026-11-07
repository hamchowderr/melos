import { z } from 'zod';
import { PITCH_STATUSES } from '../dto/pitches';

/** Pitch write tool names and inputs (docs/CONTRACT.md §3.3). Zod only. */
export const CREATE_PITCH_TOOL_NAME = 'createPitch';
export const ADD_PITCH_ITEM_TOOL_NAME = 'addPitchItem';
export const ADD_PITCH_NOTE_TOOL_NAME = 'addPitchNote';
export const TRANSITION_PITCH_STATUS_TOOL_NAME = 'transitionPitchStatus';

const songSchema = z.object({
  itemType: z.enum(['composition', 'recording']),
  itemId: z.string().min(1),
});

const note = z.string().min(1).max(4000);
const followUp = z
  .string()
  .datetime({ offset: true })
  .describe('ISO timestamp for the next follow-up; later than the last contact.');

export const createPitchInputSchema = z.object({
  contactId: z.string().min(1),
  items: z.array(songSchema).min(1).max(50).describe('The songs, in order.'),
  subject: z.string().min(1).max(300).optional(),
  note: note.optional().describe('An opening note on the pitch.'),
});

export const addPitchItemInputSchema = songSchema.extend({ pitchId: z.string().min(1) });

export const addPitchNoteInputSchema = z.object({
  pitchId: z.string().min(1),
  note,
  pitchItemId: z.string().min(1).optional().describe('Put the note on one song of the pitch.'),
  nextFollowUpAt: followUp.optional(),
});

export const transitionPitchStatusInputSchema = z.object({
  pitchItemId: z.string().min(1),
  toStatus: z.enum(PITCH_STATUSES),
  note: note.optional(),
  nextFollowUpAt: followUp.optional(),
});
