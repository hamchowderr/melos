import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ContactDetailDTO } from '../../src/lib/dto/contacts';
import { summarizeContact, summarizeContacts } from '../../src/mastra/tools/contacts';

const { fixtures } = JSON.parse(readFileSync('fixtures/agui/renderers.json', 'utf8')) as {
  fixtures: { toolName: string; result: { value: unknown } }[];
};
const value = (toolName: string) => fixtures.find((f) => f.toolName === toolName)?.result.value;

describe('melos-ajt.12: contact tools model output (§3.6)', () => {
  it('keeps ids, names, roles and cell statuses, and no email address or phone', () => {
    const detail = value('getContact') as ContactDetailDTO;
    const model = [summarizeContacts([detail]), summarizeContact(detail)];
    expect(JSON.stringify(model)).not.toMatch(/@|supervisor@mock|cm_AGUI1/);
    expect(model[1]).toEqual({
      ...{ contactId: 'con_AGUI1', partyId: 'pty_AGUI_SUP', displayName: 'Mock Supervisor' },
      ...{ organizationName: 'Mock Sync Co', roles: ['music_supervisor'] },
      pitchItems: [
        { pitchItemId: 'pti_AGUI1', itemTitle: 'Harbor Lights', currentStatus: 'awaiting_reply' },
      ],
    });
  });
});
