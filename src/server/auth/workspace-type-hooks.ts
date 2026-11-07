import { APIError } from 'better-auth/api';
import type { OrganizationOptions } from 'better-auth/plugins/organization';
import { workspaceMetadataError } from '../../lib/workspace-type';

function check(metadata: unknown) {
  const message = workspaceMetadataError(metadata);
  if (message) throw APIError.from('BAD_REQUEST', { code: 'INVALID_WORKSPACE_TYPE', message });
}

/** ONB-001: organization metadata holds only a known workspace type, on create and on update. */
export const workspaceTypeHooks = {
  beforeCreateOrganization: async ({ organization }) => check(organization.metadata),
  beforeUpdateOrganization: async ({ organization }) => check(organization.metadata),
} satisfies NonNullable<OrganizationOptions['organizationHooks']>;
