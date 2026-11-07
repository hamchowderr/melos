import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PitchDTO, PitchSummary } from '../../src/lib/dto/pitches';
import { summarizePitch, summarizePitches } from '../../src/mastra/tools/pitches';

const { fixtures } = JSON.parse(readFileSync('fixtures/agui/renderers.json', 'utf8')) as {
  fixtures: { toolName: string; result: { value: unknown } }[];
};
const value = (toolName: string) => fixtures.find((f) => f.toolName === toolName)?.result.value;

describe('melos-ajt.13: pitch tools model output (§3.6)', () => {
  it('searchPitches keeps the cell ids, song, status and follow-up, not the roles', () => {
    const [cell] = summarizePitches(value('searchPitches') as PitchSummary[]);
    expect(cell).toEqual({
      ...{ pitchId: 'pit_AGUI1', pitchItemId: 'pti_AGUI1', contactId: 'con_AGUI1' },
      ...{ contactName: 'Mock Supervisor', itemType: 'composition', itemId: 'cmp_AGUI1' },
      ...{ itemTitle: 'Harbor Lights', currentStatus: 'awaiting_reply' },
      ...{ nextFollowUpAt: '2026-09-10T17:00:00.000Z', followUpDue: true },
      lastOutboundMessageId: 'msg_AGUI1',
    });
  });

  it('getPitch keeps the cells and the last sent outbound message, not the events', () => {
    const pitch = summarizePitch(value('getPitch') as PitchDTO);
    expect(pitch).toEqual({
      ...{ pitchId: 'pit_AGUI1', contactId: 'con_AGUI1', contactName: 'Mock Supervisor' },
      subject: 'Harbor Lights for your show',
      items: [
        {
          ...{ pitchItemId: 'pti_AGUI1', itemId: 'cmp_AGUI1', itemTitle: 'Harbor Lights' },
          currentStatus: 'awaiting_reply',
        },
      ],
      lastOutboundMessage: {
        ...{ messageId: 'msg_AGUI1', subject: 'Harbor Lights for your show' },
        sentAt: '2026-09-03T17:00:00.000Z',
      },
      nextFollowUpAt: '2026-09-10T17:00:00.000Z',
    });
  });
});
