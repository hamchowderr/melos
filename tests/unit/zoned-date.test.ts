import { describe, expect, it } from 'vitest';
import { followUpDue, roleRankOf } from '../../src/lib/dto/pitches';
import { dateIn, daysBetween, endOfDate, isTimeZone } from '../../src/lib/zoned-date';

describe('melos-ajt.2: member-timezone dates and followUpDue (§6.4, P-24)', () => {
  it('ends a day at its last local instant, across daylight saving changes', () => {
    expect(endOfDate('2026-09-14', 'America/Los_Angeles')).toBe('2026-09-15T06:59:59.999Z');
    expect(endOfDate('2026-09-14', 'UTC')).toBe('2026-09-14T23:59:59.999Z');
    // 2026-03-08 springs forward and 2026-11-01 falls back in Los Angeles.
    expect(endOfDate('2026-03-08', 'America/Los_Angeles')).toBe('2026-03-09T06:59:59.999Z');
    expect(endOfDate('2026-11-01', 'America/Los_Angeles')).toBe('2026-11-02T07:59:59.999Z');
    expect(endOfDate('2026-09-14', 'Asia/Kolkata')).toBe('2026-09-14T18:29:59.999Z');
  });

  it('reads local dates, day gaps and timezone names', () => {
    expect(dateIn('America/Los_Angeles', new Date('2026-09-15T03:00:00Z'))).toBe('2026-09-14');
    expect(daysBetween('2026-09-11T18:00:00.000Z', '2026-09-14', 'America/Los_Angeles')).toBe(3);
    expect(isTimeZone('America/Los_Angeles')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });

  it('is due only for follow-up statuses after the last contact', () => {
    const end = '2026-09-15T06:59:59.999Z';
    const cell = {
      currentStatus: 'awaiting_reply' as const,
      nextFollowUpAt: '2026-09-11T18:00:00.000Z',
      lastContactedAt: '2026-09-04T18:00:00.000Z',
    };
    expect(followUpDue(cell, end)).toBe(true);
    expect(followUpDue({ ...cell, currentStatus: 'passed' }, end)).toBe(false);
    expect(followUpDue({ ...cell, nextFollowUpAt: null }, end)).toBe(false);
    expect(followUpDue({ ...cell, nextFollowUpAt: '2026-09-15T09:00:00.000Z' }, end)).toBe(false);
    expect(followUpDue({ ...cell, lastContactedAt: '2026-09-12T00:00:00.000Z' }, end)).toBe(false);
    expect(followUpDue({ ...cell, lastContactedAt: null }, end)).toBe(true);
  });

  it('ranks roles licensing agent first and unknown roles last', () => {
    expect(roleRankOf(['record_label', 'licensing_agent'])).toBe(0);
    expect(roleRankOf(['blogger'])).toBe(5);
    expect(roleRankOf([])).toBe(5);
  });
});
