import { describe, expect, it } from 'vitest';
import { parseToolResult } from '@/lib/agent/tool-result';

describe('parseToolResult (U-03)', () => {
  it('reads the JSON text of a ToolResult, as the chat renderer receives it', () => {
    const ok = { status: 'ok', value: [{ title: 'Midnight Drive' }] };
    expect(parseToolResult(JSON.stringify(ok))).toEqual(ok);
  });

  it('keeps a refusal code and its details', () => {
    const error = { status: 'error', error: { code: 'NOT_FOUND', field: 'entityId' } };
    expect(parseToolResult(JSON.stringify(error))).toEqual(error);
  });

  it('accepts an already parsed object', () => {
    expect(parseToolResult({ status: 'ok', value: 1 })).toEqual({ status: 'ok', value: 1 });
  });

  it('returns null for text that is not a ToolResult', () => {
    expect(parseToolResult('not json')).toBeNull();
    expect(parseToolResult(JSON.stringify({ title: 'x' }))).toBeNull();
    expect(parseToolResult(undefined)).toBeNull();
  });
});
