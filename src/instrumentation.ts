/** Fails server startup with the list of bad env variable names (never values), chat model included. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { getServerEnv, requireChatModel } = await import('./server/env');
    requireChatModel(getServerEnv().chatModel);
  }
}
