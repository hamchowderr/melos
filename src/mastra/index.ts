import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { ensureLocalDatabaseDir } from '../server/db/local-database';
import { getServerEnv } from '../server/env';
import { createWorkspaceAgent } from './agents/workspace-agent';
import { toModelConfig } from './model';

const env = getServerEnv();
ensureLocalDatabaseDir(env.agentDatabase.url);

export const mastra = new Mastra({
  agents: { melos: createWorkspaceAgent(toModelConfig(env.chatModel)) },
  // Agent runtime storage (threads, memory), kept separate from the control plane.
  storage: new LibSQLStore({
    id: 'melos-agent-storage',
    url: env.agentDatabase.url,
    authToken: env.agentDatabase.authToken,
  }),
});
