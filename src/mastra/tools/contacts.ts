import { createTool } from '@mastra/core/tools';
import {
  GET_CONTACT_TOOL_NAME,
  getContactInputSchema,
  SEARCH_CONTACTS_TOOL_NAME,
  searchContactsInputSchema,
} from '../../lib/agent/crm-tools';
import { toolResultSchema } from '../../lib/agent/tool-result';
import type { ContactDetailDTO, ContactSummary } from '../../lib/dto/contacts';
import { getContact } from '../../server/services/contacts/contacts';
import { searchContacts } from '../../server/services/contacts/search';
import { modelOutput, runTool } from './run-tool';

/** searchContacts's §3.6 model fields. Email addresses and phone numbers stay in the UI. */
const contactFields = (contact: ContactSummary) => ({
  contactId: contact.contactId,
  partyId: contact.partyId,
  displayName: contact.displayName,
  organizationName: contact.organizationName,
  roles: contact.roles,
});

export const summarizeContacts = (contacts: ContactSummary[]) => contacts.map(contactFields);

/** getContact's §3.6 model fields: the contact and each pitch cell's item and status. */
export const summarizeContact = (contact: ContactDetailDTO) => ({
  ...contactFields(contact),
  pitchItems: contact.pitchItems.map(({ pitchItemId, itemTitle, currentStatus }) => ({
    pitchItemId,
    itemTitle,
    currentStatus,
  })),
});

export const searchContactsTool = createTool({
  id: SEARCH_CONTACTS_TOOL_NAME,
  description:
    'Find industry contacts (music supervisors, A&R, agencies) by name, company or email, by role, or by a song they were pitched. Use it to turn a person the user names into a contact id.',
  inputSchema: searchContactsInputSchema,
  outputSchema: toolResultSchema<ContactSummary[]>(),
  execute: (input, context) => runTool(context, (tenant) => searchContacts(tenant, input)),
  toModelOutput: modelOutput(summarizeContacts),
});

export const getContactTool = createTool({
  id: GET_CONTACT_TOOL_NAME,
  description:
    "One contact's profile: company, roles, every song pitched to them with its status, and their recent messages.",
  inputSchema: getContactInputSchema,
  outputSchema: toolResultSchema<ContactDetailDTO>(),
  execute: ({ contactId }, context) => runTool(context, (tenant) => getContact(tenant, contactId)),
  toModelOutput: modelOutput(summarizeContact),
});
