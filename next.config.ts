import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Mastra, the native libSQL client and the CopilotKit runtime are not
  // bundler-safe; load them from node_modules at runtime instead.
  serverExternalPackages: [
    '@mastra/core',
    '@mastra/memory',
    '@mastra/libsql',
    '@libsql/client',
    '@libsql/core',
    'libsql',
    '@copilotkit/runtime',
    '@ag-ui/mastra',
  ],
  // `next dev` logs request URLs; auth email links (token, invitation id) must not reach logs.
  logging: { incomingRequests: { ignore: [/\/api\/auth\/verify-email/, /\/invitations\//] } },
};

export default nextConfig;
