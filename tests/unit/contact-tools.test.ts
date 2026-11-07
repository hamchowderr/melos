import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ContactDetailDTO } from '../../src/lib/dto/contacts';
import type { PitchEligibilityDTO } from '../../src/lib/dto/pitches';
import {
  summarizeContact,summarizeContact, 
  summarizeContacts,summarizeContacts, 
  summarizeEligibility
} from '../../src/mastra/tools/contacts';

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

  it('lists eligible contacts with their list name and planned cell (melos-ajt.12)', () => {
    const eligibility = value('searchPitchEligibility') as PitchEligibilityDTO;
    expect(summarizeEligibility(eligibility)).toEqual({
      itemType: 'composition',
      itemId: 'cmp_AGUI1',
      contacts: [
        {
          ...{
            contactId: 'con_AGUI1',
            displayName: 'Mock Supervisor',
            roles: ['music_supervisor'],
          },
          ...{ list: 'planned_not_contacted', pitchItemId: 'pti_AGUI1' },
        },
        {
          ...{ contactId: 'con_AGUI2', displayName: 'Mock Agent', roles: ['licensing_agent'] },
          list: 'never_pitched',
        },
      ],
    });
  });
});
