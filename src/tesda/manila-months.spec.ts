import { manilaMonthStart } from './manila-months';

const at = (iso: string) => Date.parse(iso) / 1000;

describe('Manila months', () => {
  it('gives the epoch of 00:00 Manila on the 1st, across a year end', () => {
    expect(manilaMonthStart('2026-12')).toBe(at('2026-11-30T16:00:00Z'));
    expect(manilaMonthStart('2027-01')).toBe(at('2026-12-31T16:00:00Z'));
  });

  it('gives null for anything that is not a month', () => {
    expect(manilaMonthStart('2026-13')).toBeNull();
    expect(manilaMonthStart('2026-12-01')).toBeNull();
    expect(manilaMonthStart('soon')).toBeNull();
  });
});
