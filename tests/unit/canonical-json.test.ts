import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/server/services/audit-writer';

/** What canonicalJson throws for `value`, or undefined when it returns. */
function refusal(value: unknown): unknown {
  try {
    canonicalJson(value);
  } catch (error) {
    return error;
  }
}

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

  it('throws for NaN, Infinity and -Infinity at any depth, which JSON.stringify writes as null', () => {
    // Probe: JSON.stringify would hash { a: NaN } like { a: null }.
    expect(JSON.stringify({ a: Number.NaN })).toBe(JSON.stringify({ a: null }));
    const numbers = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const number of numbers) {
      const error = new TypeError(`canonicalJson cannot represent ${number}`);
      for (const value of [number, { a: number }, [1, number]]) {
        expect(refusal(value), String(number)).toStrictEqual(error);
      }
    }
  });

  it('throws for a boxed primitive at any depth instead of unwrapping it, and for a bigint', () => {
    const error = new TypeError('canonicalJson refuses a boxed primitive');
    for (const boxed of [Object(1), Object('a'), Object(false), Object(1n), Object(Symbol('s'))]) {
      expect(refusal(boxed)).toStrictEqual(error);
      expect(refusal({ value: [boxed] })).toStrictEqual(error);
    }
    expect(refusal(1n)).toBeInstanceOf(TypeError);
  });

  it('throws a TypeError for a cycle instead of overflowing the stack, and writes a shared object each time', () => {
    const loop: Record<string, unknown> = { name: 'loop' };
    loop.self = loop;
    const list: unknown[] = [];
    list.push({ list });
    const error = new TypeError('canonicalJson cannot serialize a cycle');
    expect([refusal(loop), refusal(list)]).toStrictEqual([error, error]);
    const shared = { id: 1 };
    expect(canonicalJson({ a: shared, b: [shared] })).toBe('{"a":{"id":1},"b":[{"id":1}]}');
  });
});
