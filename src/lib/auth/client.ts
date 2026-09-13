import { organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { ac, roles } from './permissions';

// No baseURL: the client talks to the origin it was served from, so previews work unchanged.
export const authClient = createAuthClient({
  plugins: [organizationClient({ ac, roles })],
});
