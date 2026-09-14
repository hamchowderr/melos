import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/server/services/audit-writer';

describe('canonicalJson (§7.4)', () => {
  it('sorts keys by code unit at every depth, keeps array order and adds no whitespace', () => {
    const built = { b: [3, { z: 1, a: [2, 1] }], a: { d: 'x', c: null }, 10: true, 2: false };
    const reordered = { 2: false, a: { c: null, d: 'x' }, 10: true, b: [3, { a: [2, 1], z: 1 }] };
    const text = '{"10":true,"2":false,"a":{"c":null,"d":"x"},"b":[3,{"a":[2,1],"z":1}]}';
    expect([canonicalJson(built), canonicalJson(reordered)]).toEqual([text, text]);
  });

  it('keeps null, leaves out undefined properties, writes undefined array items as null and applies toJSON', () => {
    const at = new Date('2026-09-14T18:00:00.000Z');
    const value = { kept: null, left: undefined, at, list: [undefined, null, 'é\n', () => 1] };
    const text = '{"at":"2026-09-14T18:00:00.000Z","kept":null,"list":[null,null,"é\\n",null]}';
    expect(canonicalJson(value)).toBe(text);
    expect(canonicalJson(JSON.parse(JSON.stringify(value)))).toBe(text);
  });

  it('throws for a value with no JSON form', () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
  });
});
