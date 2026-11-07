import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WORKSPACE_TYPES, type WorkspaceType } from '../../src/lib/workspace-type';
import { organization } from '../../src/server/db/schema/auth';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;

let services: Services;
let onboarding: typeof import('../../src/server/services/onboarding/checklist');
let controlDb: typeof import('../../src/server/db/client').controlDb;
let northstar: TenantContext;
let empty: TenantContext;

function accepted<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`Refused with ${JSON.stringify(result.error)}`);
  return result.value;
}

async function setType(tenant: TenantContext, workspaceType: WorkspaceType | null) {
  const metadata = workspaceType ? JSON.stringify({ workspaceType }) : null;
  await controlDb
    .update(organization)
    .set({ metadata })
    .where(eq(organization.id, tenant.organizationId));
}

async function checklist(tenant: TenantContext, workspaceType: WorkspaceType) {
  await setType(tenant, workspaceType);
  return accepted(await onboarding.getOnboardingChecklist(tenant));
}

const ticks = (list: { items: { key: string; done: boolean }[] }) =>
  Object.fromEntries(list.items.map((item) => [item.key, item.done]));

beforeAll(async () => {
  services = await prepareWorkspaceServices('onboarding-checklist');
  onboarding = await import('../../src/server/services/onboarding/checklist');
  ({ controlDb } = await import('../../src/server/db/client'));
  northstar = await seedNorthstarTenant();
  empty = await services.provision('owner');
});

afterAll(async () => {
  if (northstar) await services.connections.closeWorkspaceDatabase(northstar.workspaceId);
  await services?.close();
});

/** CONTRACT §5.10 item keys per type, in table order. */
const KEYS: Record<WorkspaceType, string[]> = {
  songwriter: ['first_song', 'writer_splits', 'licensing_contact', 'first_pitch'],
  producer: ['first_song', 'writer_splits', 'co_writer', 'producer_credit'],
  sync_agent: [
    'first_song',
    'ready_song',
    'supervisor_contact',
    'first_pitch',
    'multi_song_report',
  ],
  label: ['catalog_import', 'master_owners', 'licensing_contact', 'first_pitch'],
  manager: ['first_song', 'artist_songs', 'contacts', 'first_pitch', 'follow_up'],
};

/** Northstar has songs, splits, masters, contacts, pitches and follow-ups, but no producer credit
 * and no multi-song report. */
const NORTHSTAR_TICKS: Record<WorkspaceType, Record<string, boolean>> = {
  songwriter: { first_song: true, writer_splits: true, licensing_contact: true, first_pitch: true },
  producer: { first_song: true, writer_splits: true, co_writer: true, producer_credit: false },
  sync_agent: {
    ...{ first_song: true, ready_song: true, supervisor_contact: true, first_pitch: true },
    multi_song_report: false,
  },
  label: { catalog_import: true, master_owners: true, licensing_contact: true, first_pitch: true },
  manager: {
    ...{ first_song: true, artist_songs: true, contacts: true, first_pitch: true },
    follow_up: true,
  },
};

describe('ONB-INT-004: getOnboardingChecklist', () => {
  it.each(WORKSPACE_TYPES)('lists the %s items, none done, in an empty workspace', async (type) => {
    const list = await checklist(empty, type);
    expect(list.workspaceType).toBe(type);
    expect(list.items.map((item) => item.key)).toEqual(KEYS[type]);
    expect(list.items.every((item) => !item.done && item.href.startsWith('/'))).toBe(true);
    expect(list).toMatchObject({ doneCount: 0, total: KEYS[type].length, dismissed: false });
  });

  it.each(WORKSPACE_TYPES)('derives the %s ticks from the Northstar seed', async (type) => {
    const list = await checklist(northstar, type);
    expect(list.items.map((item) => item.key)).toEqual(KEYS[type]);
    expect(list.doneCount).toBe(list.items.filter((item) => item.done).length);
    expect(ticks(list)).toEqual(NORTHSTAR_TICKS[type]);
  });

  it('names the sync agent first item for a represented catalog', async () => {
    const list = await checklist(empty, 'sync_agent');
    expect(list.items[0].label).toBe('Add the catalog you represent');
  });

  it('ONB-006: reads a workspace with no type as songwriter', async () => {
    await setType(empty, null);
    const list = accepted(await onboarding.getOnboardingChecklist(empty));
    expect(list.workspaceType).toBe('songwriter');
  });

  it('is readable by a viewer', async () => {
    expect((await onboarding.getOnboardingChecklist(withRole(empty, 'viewer'))).ok).toBe(true);
  });
});

describe('ONB-003: dismissing the checklist', () => {
  it('marks it dismissed for that member only and keeps the stored timezone', async () => {
    const settings = await import('../../src/server/services/member-settings');
    const other = { ...northstar, userId: 'usr_other_member' };
    expect(accepted(await onboarding.getOnboardingChecklist(northstar)).dismissed).toBe(false);
    await settings.dismissOnboarding(northstar, 'Europe/Berlin');
    expect(accepted(await onboarding.getOnboardingChecklist(northstar)).dismissed).toBe(true);
    expect(await settings.getMemberTimezone(northstar)).toBe('America/Los_Angeles');
    expect(accepted(await onboarding.getOnboardingChecklist(other)).dismissed).toBe(false);
  });
});
