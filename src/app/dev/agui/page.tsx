import { notFound } from 'next/navigation';
import { AguiHarness } from '@/components/chat/agui-harness';

export const dynamic = 'force-dynamic';

/** Only a loopback AGUIMock: the harness never points the chat at another host. */
const LOOPBACK_AGENT = /^http:\/\/127\.0\.0\.1:\d{2,5}\/[A-Za-z0-9/_-]*$/;

/**
 * The TST-AI-003 harness: exists only when the e2e server sets MELOS_E2E_HARNESS=1, and is a 404
 * in every other build, production included.
 */
export default async function AguiHarnessPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string }>;
}) {
  const { agent } = await searchParams;
  if (process.env.MELOS_E2E_HARNESS !== '1' || !agent || !LOOPBACK_AGENT.test(agent)) notFound();
  return <AguiHarness agentUrl={agent} />;
}
