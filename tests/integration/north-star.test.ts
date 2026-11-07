import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pitches } from '../../src/server/db/schema/workspace.generated';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

let services: Awaited<ReturnType<typeof prepareWorkspaceServices>>;
let drafts: typeof import('../../src/server/services/outreach/drafts');
let send: typeof import('../../src/server/services/outreach/send');
let metrics: typeof import('../../src/server/services/metrics/north-star');
let sandbox: InstanceType<
  typeof import('../../src/server/services/outreach/email-transport')['SandboxEmailTransport']
>;
let owner: TenantContext;
const k = NORTHSTAR.keys;
const DAY_MS = 86_400_000;

function accepted<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`Refused with ${JSON.stringify(result.error)}`);
  return result.value;
}
const sendDraft = async (input: Parameters<typeof drafts.draftPitchMessage>[1]) => {
  const draft = accepted(await drafts.draftPitchMessage(owner, input));
  return accepted(
    await send.sendMessage(owner, { messageId: draft.messageId }, undefined, sandbox),
  );
};

beforeAll(async () => {
  services = await prepareWorkspaceServices('north-star');
  drafts = await import('../../src/server/services/outreach/drafts');
  send = await import('../../src/server/services/outreach/send');
  metrics = await import('../../src/server/services/metrics/north-star');
  const { SandboxEmailTransport } = await import(
    '../../src/server/services/outreach/email-transport'
  );
  sandbox = new SandboxEmailTransport();
  owner = await seedNorthstarTenant();
});
afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

describe('melos-ajt.1: the North Star per workspace per week', () => {
  it('counts songs sent with a complete package and follow-ups sent on time', async () => {
    const week = new Date().toISOString().slice(0, 10);
    const before = accepted(await metrics.getNorthStarWeek(owner, week));
    // The seed's sent messages predate these facts, so nothing counts as complete yet.
    expect(before).toMatchObject({ songsPitchedComplete: 0, followUpsSent: 0 });
    expect(before.firstCompletePackageAt).toBeNull();

    // Paper Planes at 2AM is one-stop ready; the seed's due date (2026-09-14) has passed: late.
    await sendDraft({
      ...{ pitchId: k.pit_PAPER_REBECCA, purpose: 'follow_up', subject: 'Re: Paper Planes' },
      bodyText: 'Checking in.',
    });
    // Neon Static is not one-stop ready (EXPECTED §2), so its send counts but not as complete.
    await sendDraft({
      ...{ pitchId: k.pit_NEON_MALIK, purpose: 'initial', subject: 'Neon Static' },
      bodyText: 'Have a listen.',
    });

    // Midnight Drive with Maya, due a week from now: on time.
    const database = await services.connections.getWorkspaceDatabase(owner.workspaceId);
    await database
      .update(pitches)
      .set({ nextFollowUpAt: new Date(Date.now() + 7 * DAY_MS).toISOString() })
      .where(eq(pitches.id, k.pit_MIDNIGHT_MAYA));
    await sendDraft({
      ...{ pitchId: k.pit_MIDNIGHT_MAYA, purpose: 'follow_up', subject: 'Re: Midnight Drive' },
      bodyText: 'Any news?',
    });

    const after = accepted(await metrics.getNorthStarWeek(owner, week));
    expect(after).toMatchObject({
      ...{ songsPitchedComplete: 2, songsPitched: 3, followUpsSent: 2, followUpsOnTime: 1 },
      ...{ songsMadePitchReady: null, catalogsImported: null },
    });
    expect(after.firstCompletePackageAt?.slice(0, 10)).toBe(week);
    const lastWeek = new Date(Date.parse(week) - 7 * DAY_MS).toISOString().slice(0, 10);
    expect(accepted(await metrics.getNorthStarWeek(owner, lastWeek)).songsPitchedComplete).toBe(0);
  });

  it('is owner only and wants a date', async () => {
    expect(await metrics.getNorthStarWeek(withRole(owner, 'admin'), '2026-11-02')).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(await metrics.getNorthStarWeek(owner, 'last week')).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', field: 'weekStart' },
    });
  });
});
