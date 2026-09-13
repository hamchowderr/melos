/** Fails server startup with the list of bad env variable names (never values). */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { getServerEnv } = await import('./server/env');
    getServerEnv();
  }
}
