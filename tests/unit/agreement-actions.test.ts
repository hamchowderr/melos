import { expect, it, vi } from 'vitest';
import { saveNewAgreement } from '../../src/app/rights/agreement-actions';

const resolve = vi.hoisted(() => vi.fn(async () => ({ status: 'no-workspace' })));
vi.mock('../../src/app/workspace-action', () => ({ resolveWorkspaceAction: resolve }));
vi.mock('../../src/server/services/rights/agreements', () => ({ createAgreement: vi.fn() }));

it('melos-rpr.47: refuses a non-string field as VALIDATION before resolving the workspace', async () => {
  const valid = { agreementType: 'representation', title: 'Deal' };
  const cases: [unknown, string][] = [
    [null, 'agreementType'],
    [{ ...valid, title: 5 }, 'title'],
    [{ ...valid, counterpartyPartyId: 7 }, 'counterpartyPartyId'],
    [{ ...valid, expiresOn: {} }, 'expiresOn'],
  ];
  for (const [input, field] of cases) {
    expect(await saveNewAgreement(input)).toEqual({ ok: false, code: 'VALIDATION', field });
  }
  expect(resolve).not.toHaveBeenCalled();
  expect(await saveNewAgreement({ ...valid, effectiveOn: null })).toEqual({
    ok: false,
    code: 'no-workspace',
  });
});
