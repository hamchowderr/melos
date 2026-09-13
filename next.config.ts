import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Mastra, the native libSQL client and the CopilotKit runtime are not
  // bundler-safe; load them from node_modules at runtime instead.
  serverExternalPackages: [
    '@mastra/core',
    '@mastra/memory',
    '@mastra/libsql',
    '@libsql/client',
    'libsql',
    '@copilotkit/runtime',
    '@ag-ui/mastra',
  ],
};

export default nextConfig;
