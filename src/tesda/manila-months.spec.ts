import { nextQuarterMonths, upcomingMonths } from './manila-months';

const at = (iso: string) => Date.parse(iso) / 1000;

describe('Manila months', () => {
  it('starts at this month in Manila, not in UTC', () => {
    // 31 Oct 17:00 UTC is already 1 Nov 01:00 in Manila
    expect(upcomingMonths(at('2026-10-31T17:00:00Z'), 2).map((m) => m.label)).toEqual(['2026-11-01', '2026-12-01']);
  });

  it('gives the epoch of 00:00 Manila on the 1st, across a year end', () => {
    const [dec, jan] = upcomingMonths(at('2026-12-15T00:00:00Z'), 2);
    expect(dec).toEqual({ label: '2026-12-01', epoch: at('2026-11-30T16:00:00Z') });
    expect(jan).toEqual({ label: '2027-01-01', epoch: at('2026-12-31T16:00:00Z') });
  });

  it('next quarter is the next calendar quarter', () => {
    expect(nextQuarterMonths(at('2026-10-27T00:00:00Z')).map((m) => m.label)).toEqual(['2027-01-01', '2027-02-01', '2027-03-01']);
    expect(nextQuarterMonths(at('2026-03-31T15:00:00Z')).map((m) => m.label)).toEqual(['2026-04-01', '2026-05-01', '2026-06-01']);
    // 31 Mar 17:00 UTC is 1 Apr in Manila: already Q2, so next is Q3
    expect(nextQuarterMonths(at('2026-03-31T17:00:00Z')).map((m) => m.label)).toEqual(['2026-07-01', '2026-08-01', '2026-09-01']);
  });
});
