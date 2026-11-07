import { describe, expect, it } from 'vitest';
import {
  readWorkspaceType,
  WORKSPACE_TYPE_INFO,
  WORKSPACE_TYPES,
  workspaceMetadataError,
} from '../../src/lib/workspace-type';

describe('ONB-UNIT-006: readWorkspaceType', () => {
  it('reads a stored type from an object or a JSON string', () => {
    expect(readWorkspaceType({ workspaceType: 'manager' })).toBe('manager');
    expect(readWorkspaceType('{"workspaceType":"sync_agent"}')).toBe('sync_agent');
  });

  it.each([undefined, null, '', 'not json', '{}', { workspaceType: 'dj' }, { workspaceType: 3 }])(
    'reads %j as songwriter',
    (metadata) => {
      expect(readWorkspaceType(metadata)).toBe('songwriter');
    },
  );
});

describe('ONB-001: workspaceMetadataError', () => {
  it('allows no metadata and every known type', () => {
    expect(workspaceMetadataError(undefined)).toBeNull();
    expect(workspaceMetadataError(null)).toBeNull();
    for (const workspaceType of WORKSPACE_TYPES) {
      expect(workspaceMetadataError({ workspaceType })).toBeNull();
    }
  });

  it.each([
    [{ workspaceType: 'dj' }],
    [{}],
    [{ workspaceType: 'label', plan: 'pro' }],
    [['label']],
    ['nope'],
  ])('refuses %j', (metadata) => {
    expect(workspaceMetadataError(metadata)).toEqual(expect.any(String));
  });
});

describe('workspace type table (CONTRACT §5.10)', () => {
  it('gives each type a start page from the contract', () => {
    expect(
      Object.fromEntries(
        WORKSPACE_TYPES.map((type) => [type, WORKSPACE_TYPE_INFO[type].startPath]),
      ),
    ).toEqual({
      songwriter: '/catalog',
      producer: '/catalog',
      sync_agent: '/today',
      label: '/catalog',
      manager: '/today',
    });
  });
});
