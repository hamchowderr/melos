import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { messages } from '../../src/server/db/schema/workspace.generated';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;

let services: Services;
let today: typeof import('../../src/server/services/pitches/today');
let settings: typeof import('../../src/server/services/member-settings');
let owner: TenantContext;
const k = NORTHSTAR.keys;
const DATE = NORTHSTAR.demo.date;

function accepted<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`Refused with ${JSON.stringify(result.error)}`);
  return result.value;
}

beforeAll(async () => {
  services = await prepareWorkspaceServices('today-workspace');
  today = await import('../../src/server/services/pitches/today');
  settings = await import('../../src/server/services/member-settings');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

describe('melos-ajt.5: the member timezone row (P-24)', () => {
  it('stores the first browser timezone once and falls back to UTC', async () => {
    const other = await services.provision('owner');
    const jordan = { organizationId: other.organizationId, userId: k.usr_JORDAN };
    expect(await settings.getMemberTimezone(jordan)).toBe('UTC');
    expect(await settings.recordMemberTimezone(jordan, 'Europe/Berlin')).toBe('Europe/Berlin');
    expect(await settings.recordMemberTimezone(jordan, 'Asia/Tokyo')).toBe('Europe/Berlin');
    expect(await settings.getMemberTimezone(jordan)).toBe('Europe/Berlin');
    // Northstar's seeded row stays as seeded.
    expect(await settings.recordMemberTimezone(owner, 'UTC')).toBe('America/Los_Angeles');
    const third = await services.provision('owner');
    const unknown = { organizationId: third.organizationId, userId: k.usr_JORDAN };
    expect(await settings.recordMemberTimezone(unknown, 'Mars/Olympus')).toBe('UTC');
  });
});

describe('melos-ajt.5: getTodayWorkspace (CRM-005, DEMO-010)', () => {
  it('DEMO-010: orders the due queue by P-31 priority in Los Angeles', async () => {
    const workspace = accepted(await today.getTodayWorkspace(owner, { date: DATE }));
    expect(workspace).toMatchObject({ date: DATE, timezone: 'America/Los_Angeles' });
    expect(workspace.followUpsDue.map((cell) => [cell.priorityRank, cell.pitchItemId])).toEqual(
      ['PAPER_REBECCA', 'MIDNIGHT_MAYA', 'MIDNIGHT_REBECCA', 'NEON_MAYA', 'NEON_REBECCA'].map(
        (name, index) => [index + 1, k[`pti_${name}`]],
      ),
    );
    expect(workspace.recentReplies).toEqual([]);
    expect(workspace.readinessIssues.recordings.every((entry) => !entry.syncReady)).toBe(true);
    for (const entry of workspace.readyToPitch)
      expect(entry.neverPitchedLicensingAgentCount).toBeGreaterThan(0);
  });

  it('lists the cells of a pitch with a reply in the last 7 days', async () => {
    const database = await services.connections.getWorkspaceDatabase(owner.workspaceId);
    const at = '2026-09-13T20:00:00.000Z';
    await database.insert(messages).values({
      ...{
        id: 'msg_reply_test',
        pitchId: k.pit_NEON_MAYA,
        direction: 'inbound',
        status: 'received',
      },
      ...{
        purpose: 'reply',
        subject: 'Re: Neon Static',
        receivedAt: at,
        createdAt: at,
        updatedAt: at,
      },
    });
    const workspace = accepted(await today.getTodayWorkspace(owner, { date: DATE }));
    expect(workspace.recentReplies).toMatchObject([
      { pitchItemId: k.pti_NEON_MAYA, receivedAt: at },
    ]);
    const later = accepted(await today.getTodayWorkspace(owner, { date: '2026-09-21' }));
    expect(later.recentReplies).toEqual([]);
  });

  it('defaults to today, refuses a bad date and a role without pitch:read', async () => {
    const workspace = accepted(await today.getTodayWorkspace(owner));
    expect(workspace.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await today.getTodayWorkspace(owner, { date: 'tomorrow' })).toEqual({
      ok: false,
      error: { code: 'VALIDATION', field: 'date', reason: 'date' },
    });
    expect(await today.getTodayWorkspace(withRole(owner, 'owner,viewer'))).toMatchObject({
      ok: false,
    });
    expect(
      accepted(await today.getTodayWorkspace(withRole(owner, 'viewer'), { date: DATE })).date,
    ).toBe(DATE);
  });
});
