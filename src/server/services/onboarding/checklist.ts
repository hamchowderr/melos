import { sql } from 'drizzle-orm';
import type { OnboardingChecklistDTO } from '../../../lib/dto/onboarding';
import type { WorkspaceType } from '../../../lib/workspace-type';
import { isOnboardingDismissed } from '../member-settings';
import { requirePermission } from '../permissions';
import { getReadinessIssues } from '../rights/read';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized } from '../workspace-connections';
import { getWorkspaceType } from './workspace-type';

/** Checks answered by one SQL query; `ready_song` reads the readiness service instead. */
const CHECKS = {
  any_song: sql`EXISTS (SELECT 1 FROM compositions WHERE deleted_at IS NULL)`,
  csv_import: sql`EXISTS (SELECT 1 FROM import_runs WHERE source_system = 'csv' AND status IN ('succeeded','partial'))`,
  writer_splits: sql`EXISTS (SELECT 1 FROM composition_contributors cc JOIN compositions c ON c.id = cc.composition_id WHERE c.deleted_at IS NULL GROUP BY cc.composition_id HAVING sum(cc.writer_share_bp) = 10000)`,
  co_writer: sql`EXISTS (SELECT 1 FROM composition_contributors cc JOIN compositions c ON c.id = cc.composition_id WHERE c.deleted_at IS NULL GROUP BY cc.composition_id HAVING count(*) >= 2)`,
  producer_credit: sql`EXISTS (SELECT 1 FROM recording_contributors rc JOIN recordings r ON r.id = rc.recording_id WHERE r.deleted_at IS NULL AND rc.role = 'producer')`,
  master_owners: sql`EXISTS (SELECT 1 FROM master_interests mi JOIN recordings r ON r.id = mi.recording_id WHERE r.deleted_at IS NULL GROUP BY mi.recording_id HAVING sum(mi.share_bp) = 10000)`,
  artist_songs: sql`EXISTS (SELECT 1 FROM recording_artists ra JOIN recordings r ON r.id = ra.recording_id WHERE r.deleted_at IS NULL AND ra.role = 'primary')`,
  licensing_contact: sql`EXISTS (SELECT 1 FROM contacts c JOIN contact_roles cr ON cr.contact_id = c.id WHERE c.deleted_at IS NULL AND cr.role IN ('licensing_agent','music_supervisor'))`,
  supervisor_contact: sql`EXISTS (SELECT 1 FROM contacts c JOIN contact_roles cr ON cr.contact_id = c.id WHERE c.deleted_at IS NULL AND cr.role = 'music_supervisor')`,
  contacts: sql`EXISTS (SELECT 1 FROM contacts WHERE deleted_at IS NULL)`,
  first_pitch: sql`EXISTS (SELECT 1 FROM pitch_items)`,
  follow_up: sql`EXISTS (SELECT 1 FROM pitches WHERE next_follow_up_at IS NOT NULL)`,
  multi_song_report: sql`EXISTS (SELECT 1 FROM generated_report_items GROUP BY report_id HAVING count(*) >= 2)`,
} as const;

type Check = keyof typeof CHECKS;
type Facts = Record<Check | 'ready_song', boolean>;

type ItemRule = {
  key: string;
  label: string | ((type: WorkspaceType) => string);
  href: string;
  types: WorkspaceType[];
  done: (facts: Facts) => boolean;
};

/** CONTRACT §5.10 checklist items, in table order. */
const ITEMS: ItemRule[] = [
  {
    key: 'first_song',
    label: (type) =>
      type === 'sync_agent' ? 'Add the catalog you represent' : 'Add or import your first song',
    href: '/catalog',
    types: ['songwriter', 'producer', 'sync_agent', 'manager'],
    done: (facts) => facts.any_song,
  },
  {
    key: 'catalog_import',
    label: 'Import your catalog from a CSV',
    href: '/catalog',
    types: ['label'],
    done: (facts) => facts.csv_import || facts.any_song,
  },
  {
    key: 'writer_splits',
    label: 'Set the writer splits on a song',
    href: '/rights',
    types: ['songwriter', 'producer'],
    done: (facts) => facts.writer_splits,
  },
  {
    key: 'co_writer',
    label: 'Add a co-writer to a song',
    href: '/rights',
    types: ['producer'],
    done: (facts) => facts.co_writer,
  },
  {
    key: 'producer_credit',
    label: 'Add a producer credit to a recording',
    href: '/catalog',
    types: ['producer'],
    done: (facts) => facts.producer_credit,
  },
  {
    key: 'master_owners',
    label: 'Set the master owners on a recording',
    href: '/rights',
    types: ['label'],
    done: (facts) => facts.master_owners,
  },
  {
    key: 'ready_song',
    label: 'Get one song ready to pitch',
    href: '/rights',
    types: ['sync_agent'],
    done: (facts) => facts.ready_song,
  },
  {
    key: 'artist_songs',
    label: 'Add a song by an artist you manage',
    href: '/catalog',
    types: ['manager'],
    done: (facts) => facts.artist_songs,
  },
  {
    key: 'licensing_contact',
    label: 'Add a licensing agent or music supervisor',
    href: '/people',
    types: ['songwriter', 'label'],
    done: (facts) => facts.licensing_contact,
  },
  {
    key: 'supervisor_contact',
    label: 'Add a music supervisor',
    href: '/people',
    types: ['sync_agent'],
    done: (facts) => facts.supervisor_contact,
  },
  {
    key: 'contacts',
    label: 'Add your contacts',
    href: '/people',
    types: ['manager'],
    done: (facts) => facts.contacts,
  },
  {
    key: 'first_pitch',
    label: 'Log your first pitch',
    href: '/pitches',
    types: ['songwriter', 'sync_agent', 'label', 'manager'],
    done: (facts) => facts.first_pitch,
  },
  {
    key: 'follow_up',
    label: 'Set a follow-up date on a pitch',
    href: '/pitches',
    types: ['manager'],
    done: (facts) => facts.follow_up,
  },
  {
    key: 'multi_song_report',
    label: 'Build a multi-song report',
    href: '/reports',
    types: ['sync_agent'],
    done: (facts) => facts.multi_song_report,
  },
];

async function readFacts(
  tenant: TenantContext,
  type: WorkspaceType,
): Promise<ServiceResult<Facts>> {
  const needed = ITEMS.filter((item) => item.types.includes(type));
  const row = await sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    const columns = sql.join(
      (Object.keys(CHECKS) as Check[]).map((key) => sql`${CHECKS[key]} AS ${sql.raw(key)}`),
      sql`, `,
    );
    return (await database.all<Record<Check, number>>(sql`SELECT ${columns}`))[0];
  });
  let readySong = false;
  if (needed.some((item) => item.key === 'ready_song')) {
    const readiness = await getReadinessIssues(tenant, { onlyNotReady: false, limit: 200 });
    if (!readiness.ok) return { ok: false as const, error: readiness.error };
    readySong = readiness.value.recordings.some((recording) => recording.oneStopReady);
  }
  const facts = { ready_song: readySong } as Facts;
  for (const key of Object.keys(CHECKS) as Check[]) facts[key] = Boolean(row?.[key]);
  return success(facts);
}

/**
 * The getting-started checklist for the workspace type (ONB-003, ONB-004): every tick is derived
 * from live workspace rows on this read. catalog:read. `dismissed` is the member's choice (ONB-003).
 */
export async function getOnboardingChecklist(
  tenant: TenantContext,
): Promise<ServiceResult<OnboardingChecklistDTO>> {
  if (!requirePermission(tenant, { catalog: ['read'] }).ok) return failure('FORBIDDEN');
  const [workspaceType, dismissed] = await Promise.all([
    getWorkspaceType(tenant),
    isOnboardingDismissed(tenant),
  ]);
  const facts = await readFacts(tenant, workspaceType);
  if (!facts.ok) return facts;
  const items = ITEMS.filter((item) => item.types.includes(workspaceType)).map((item) => ({
    key: item.key,
    label: typeof item.label === 'string' ? item.label : item.label(workspaceType),
    href: item.href,
    done: item.done(facts.value),
  }));
  const doneCount = items.filter((item) => item.done).length;
  return success({ workspaceType, items, doneCount, total: items.length, dismissed });
}
