import { currentQuarter, manilaMonthStart, parseQuarter, quarterMonths, quarterOf } from './quarter';

describe('quarters (Asia/Manila)', () => {
  it('parses a calendar quarter and its three months', () => {
    const q = parseQuarter('2026-Q4')!;
    expect(q).toMatchObject({ label: '2026-Q4', year: 2026, quarter: 4 });
    expect(q.end).toBeGreaterThan(q.start);
    const months = quarterMonths(q);
    expect(months).toHaveLength(3);
    expect(months[0]).toBe(manilaMonthStart(2026, 10));
    expect(months[2]).toBe(manilaMonthStart(2026, 12));
    expect(months[2]).toBeLessThan(q.end);
  });

  it('finds the quarter of an epoch and rejects bad labels', () => {
    const q = parseQuarter('2026-Q1')!;
    expect(quarterOf(q.start).label).toBe('2026-Q1');
    expect(quarterOf(q.end - 1).label).toBe('2026-Q1');
    expect(parseQuarter('2026-Q5')).toBeNull();
    expect(parseQuarter('2026-04')).toBeNull();
  });

  it('uses the current Manila quarter', () => {
    const q = currentQuarter(Date.UTC(2026, 10, 11, 0, 0, 0)); // Nov 11 2026 08:00 Manila
    expect(q.label).toBe('2026-Q4');
  });
});
