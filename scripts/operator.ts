import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@libsql/client';
import type { ServerEnv } from '../src/server/env';
import { errorCode } from '../src/server/error-code';

type ControlModule = typeof import('../src/server/db/client');
export type Control = { env: ServerEnv; controlDb: ControlModule['controlDb'] };

/** The control client an operator script opened, closed by `runAsMain`. */
let opened: Client | undefined;

/**
 * Runs an operator script's `work` against melos-control. The app modules load only here, after
 * the script checked its arguments. A failure prints only its error name and code, never a message
 * or stack, which can hold a URL or token. Returns 2 when the environment does not validate or the
 * control client cannot be created, 1 when `work` throws, and otherwise what `work` returns.
 */
export async function withControl(work: (control: Control) => Promise<number>): Promise<number> {
  let control: Control;
  try {
    const env = (await import('../src/server/env')).getServerEnv();
    const client = await import('../src/server/db/client');
    opened = client.controlDatabaseClient;
    control = { env, controlDb: client.controlDb };
  } catch (error) {
    console.error(`Configuration error: ${errorCode(error)}`);
    return 2;
  }
  try {
    return await work(control);
  } catch (error) {
    console.error(`Failed: ${errorCode(error)}`);
    return 1;
  }
}

/** Runs `command` when `moduleUrl` is the script node started, then closes a client it opened. */
export async function runAsMain(
  moduleUrl: string,
  command: (args: string[]) => Promise<number>,
): Promise<void> {
  if (resolve(process.argv[1] ?? '') !== fileURLToPath(moduleUrl)) return;
  process.exitCode = await command(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`Failed: ${errorCode(error)}`);
    return 1;
  });
  opened?.close();
}
