/**
 * Workspace types (CONTRACT §5.10): which of the five ICPs (TS §14) describes the workspace owner.
 * Stored as `{"workspaceType": "<type>"}` in ctl `organization.metadata` (ONB-001).
 */
export const WORKSPACE_TYPES = [
  'songwriter',
  'producer',
  'sync_agent',
  'label',
  'manager',
] as const;

export type WorkspaceType = (typeof WORKSPACE_TYPES)[number];

/** ONB-006: the primary persona (CONTRACT §1.2, 2026-09-12). */
export const DEFAULT_WORKSPACE_TYPE: WorkspaceType = 'songwriter';

export const WORKSPACE_TYPE_INFO: Record<
  WorkspaceType,
  { label: string; description: string; startPath: string }
> = {
  songwriter: {
    label: 'Songwriter or artist',
    description: 'You write or perform your own songs and pitch them for sync.',
    startPath: '/catalog',
  },
  producer: {
    label: 'Producer or co-writer',
    description: 'You produce and co-write across several artists.',
    startPath: '/catalog',
  },
  sync_agent: {
    label: 'Sync licensing agent',
    description: 'You represent catalogs and pitch them to music supervisors.',
    startPath: '/today',
  },
  label: {
    label: 'Independent label',
    description: 'You run a label: artists, masters and releases.',
    startPath: '/catalog',
  },
  manager: {
    label: 'Artist manager',
    description: 'You manage artists and run their pitching and follow-ups.',
    startPath: '/today',
  },
};

export function isWorkspaceType(value: unknown): value is WorkspaceType {
  return typeof value === 'string' && (WORKSPACE_TYPES as readonly string[]).includes(value);
}

function toObject(metadata: unknown): unknown {
  if (typeof metadata !== 'string') return metadata;
  try {
    return JSON.parse(metadata);
  } catch {
    return undefined;
  }
}

/** ONB-006: the stored type, or songwriter when there is none or the code no longer knows it. */
export function readWorkspaceType(metadata: unknown): WorkspaceType {
  const value = toObject(metadata);
  if (value && typeof value === 'object' && 'workspaceType' in value) {
    const type = (value as { workspaceType: unknown }).workspaceType;
    if (isWorkspaceType(type)) return type;
  }
  return DEFAULT_WORKSPACE_TYPE;
}

/**
 * ONB-001: organization metadata may hold only `workspaceType` with a known value. Null or
 * undefined is allowed (read by ONB-006). Returns the refusal message, or null when it is valid.
 */
export function workspaceMetadataError(metadata: unknown): string | null {
  if (metadata === undefined || metadata === null) return null;
  const value = toObject(metadata);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'Workspace metadata must be an object.';
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'workspaceType')) {
    return 'Workspace metadata may hold only workspaceType.';
  }
  if (!isWorkspaceType((value as { workspaceType?: unknown }).workspaceType)) {
    return 'Choose one of the listed workspace types.';
  }
  return null;
}
