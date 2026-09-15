import { expect, it, vi } from 'vitest';
import { resolveWorkspaceAction } from '../../src/app/workspace-action';
import type { TenantResolution } from '../../src/server/services/tenant-context';

const resolve = vi.hoisted(() => vi.fn<(headers: Headers) => Promise<TenantResolution>>());
vi.mock('next/headers', () => ({ headers: async () => new Headers({ cookie: 'melos=session' }) }));
vi.mock('../../src/server/services/tenant-context', () => ({ tenantContextResolver: { resolve } }));

it('resolves a Server Action tenant from the request, or a typed refusal instead of a redirect (§7.1)', async () => {
  const ids = { userId: 'usr_1', organizationId: 'org_1', workspaceId: 'ws_1', requestId: 'req_1' };
  const ok = { status: 'ok', context: { ...ids, workspaceRole: 'viewer' } } as const;
  const migrating = { workspaceStatus: 'migrating' } as const;
  const cases: [TenantResolution, object][] = [
    [ok, { status: 'ready', tenant: ok.context }],
    [{ status: 'unauthenticated' }, { status: 'unauthenticated' }],
    [{ status: 'no-active-workspace' }, { status: 'no-workspace' }],
    [{ status: 'not-a-member' }, { status: 'no-workspace' }],
    [{ status: 'invalid-role' }, { status: 'no-workspace' }],
    [{ status: 'workspace-not-provisioned' }, { status: 'not-ready', workspaceStatus: 'failed' }],
    [
      { status: 'workspace-unavailable', ...migrating },
      { status: 'not-ready', ...migrating },
    ],
  ];
  for (const [resolution, expected] of cases) {
    resolve.mockResolvedValueOnce(resolution);
    expect(await resolveWorkspaceAction(), resolution.status).toEqual(expected);
  }
  const cookies = resolve.mock.calls.map(([headers]) => headers.get('cookie'));
  expect(cookies).toEqual(cases.map(() => 'melos=session'));
});
