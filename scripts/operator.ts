import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@libsql/client';
import type { ServerEnv } from '../src/server/env';
import { errorCode } from '../src/server/error-code';

type ControlModule = typeof import('../src/server/db/client');
export type Control = { env: ServerEnv; controlDb: ControlModule['controlDb'] };
type Command = (args: string[]) => Promise<number>;

/** The control client an operator script opened, closed by `runOperatorCommand`. */
let opened: Client | undefined;

/** Prints a failure as its error name and code, never its message or stack; returns exit code 1. */
function reportFailure(error: unknown): number {
  console.error(`Failed: ${errorCode(error)}`);
  return 1;
}

/**
 * Runs an operator script's `work` against melos-control. The app modules load only here, after
 * the script checked its arguments. A failure prints only its error name and code, never a message
 * or stack, which can hold a URL or token. Returns 2 when the environment does not validate or the
 * control client cannot be created, 1 when `work` throws, and otherwise what `work` returns.
 */
export async function withControl(work: (control: Control) => Promise<number>): Promise<number> {
  // Operator commands never call a model. Startup refuses any gateway key while VERCEL is set
  // (ADR-034), and operators set VERCEL for the Turso host, so drop the key before `getServerEnv`
  // first reads process.env.
  delete process.env.AI_GATEWAY_API_KEY;
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
    return reportFailure(error);
  }
}

/**
 * Runs `command`, then `close` (by default, of a control client `withControl` opened), and returns
 * the exit code without ever rejecting. A throw from either prints only its error name and code; a
 * failed close turns exit code 0 into 1 and keeps any other.
 */
export async function runOperatorCommand(
  args: string[],
  command: Command,
  close: () => void = () => opened?.close(),
): Promise<number> {
  let exitCode: number;
  try {
    exitCode = await command(args);
  } catch (error) {
    exitCode = reportFailure(error);
  }
  try {
    close();
  } catch (error) {
    reportFailure(error);
    if (exitCode === 0) exitCode = 1;
  }
  return exitCode;
}

/** Runs `command` through `runOperatorCommand` when `moduleUrl` is the script node started. */
export async function runAsMain(moduleUrl: string, command: Command): Promise<void> {
  let main = false;
  try {
    main = resolve(process.argv[1] ?? '') === fileURLToPath(moduleUrl);
  } catch (error) {
    process.exitCode = reportFailure(error);
  }
  if (main) process.exitCode = await runOperatorCommand(process.argv.slice(2), command);
}
