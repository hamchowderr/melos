import type { WorkspacePermissions, WorkspaceRole } from '../src/lib/auth/permissions';

export const ROLES: WorkspaceRole[] = ['owner', 'admin', 'member', 'viewer'];
const WRITERS: WorkspaceRole[] = ['owner', 'admin', 'member'];
const MANAGERS: WorkspaceRole[] = ['owner', 'admin'];

type MatrixRow = { operation: string; permissions: WorkspacePermissions; allowed: WorkspaceRole[] };

/** docs/CONTRACT.md §6.2 permission matrix, one permission per row. */
export const PERMISSION_MATRIX: MatrixRow[] = [
  { operation: 'Read catalog', permissions: { catalog: ['read'] }, allowed: ROLES },
  { operation: 'Create catalog', permissions: { catalog: ['create'] }, allowed: WRITERS },
  { operation: 'Edit catalog', permissions: { catalog: ['update'] }, allowed: WRITERS },
  { operation: 'Delete catalog records', permissions: { catalog: ['delete'] }, allowed: MANAGERS },
  { operation: 'Edit rights/splits', permissions: { rights: ['update'] }, allowed: WRITERS },
  { operation: 'Create contacts', permissions: { contact: ['create'] }, allowed: WRITERS },
  { operation: 'Update contacts', permissions: { contact: ['update'] }, allowed: WRITERS },
  { operation: 'Delete contacts', permissions: { contact: ['delete'] }, allowed: MANAGERS },
  { operation: 'Create pitches', permissions: { pitch: ['create'] }, allowed: WRITERS },
  { operation: 'Update pitches', permissions: { pitch: ['update'] }, allowed: WRITERS },
  { operation: 'Draft outreach', permissions: { outreach: ['draft'] }, allowed: WRITERS },
  { operation: 'Send external email', permissions: { outreach: ['send'] }, allowed: WRITERS },
  { operation: 'Preview reports', permissions: { report: ['read'] }, allowed: ROLES },
  {
    operation: 'Generate report snapshots',
    permissions: { report: ['generate'] },
    allowed: WRITERS,
  },
  { operation: 'Run Airtable or CSV import', permissions: { import: ['run'] }, allowed: MANAGERS },
  { operation: 'Invite members', permissions: { invitation: ['create'] }, allowed: MANAGERS },
  { operation: 'Change workspace roles', permissions: { member: ['update'] }, allowed: MANAGERS },
  { operation: 'Delete workspace', permissions: { organization: ['delete'] }, allowed: ['owner'] },
];
