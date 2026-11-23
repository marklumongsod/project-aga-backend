import { reportFigures, reportMonths } from './report-figures';

describe('reportMonths', () => {
  it('starts at the Asia/Manila month of now', () => {
    // 2026-11-30 17:00 UTC is already 1 December in Manila
    const m = reportMonths(Date.UTC(2026, 10, 30, 17) / 1000);
    expect(m.map((s) => new Date((s + 8 * 3600) * 1000).toISOString().slice(0, 10))).toEqual([
      '2026-12-01',
      '2027-01-01',
      '2027-02-01',
      '2027-03-01',
    ]);
  });
});

describe('reportFigures', () => {
  const [m0, m1, m2, m3] = [100, 200, 300, 400];
  const cities = [
    { key: 'A', provincePsgc: 'P1', regionPsgc: 'R1' },
    { key: 'B', provincePsgc: 'P1', regionPsgc: 'R1' },
    { key: 'C', provincePsgc: 'P2', regionPsgc: 'R1' },
  ];
  const run = () =>
    reportFigures({
      areas: [
        { level: 'REGION', code: 'R1', name: 'Region 1' },
        { level: 'PROVINCE', code: 'P1', name: 'Province 1' },
      ],
      cities,
      months: [m0, m1, m2, m3],
      candidates: new Map([
        [m0, new Map([['A', 10], ['B', 5], ['C', 2]])],
        [m1, new Map([['A', 4]])],
        [m2, new Map([['B', 6]])],
        [m3, new Map()],
      ]),
      // A and C are deserts today; the new center reaches A
      unreachedBefore: new Set(['A', 'C']),
      unreachedAfter: new Set(['C']),
      slots: new Map([
        [m0, new Map([['REGION:R1', 20], ['PROVINCE:P1', 0]])],
        [m1, new Map([['REGION:R1', 20], ['PROVINCE:P1', 0]])],
      ]),
      pinSlots: new Map([
        [m0, 10],
        [m1, 10],
      ]),
    });

  it('counts flagged candidates and deserts per month, before and after', () => {
    const [region, province] = run();
    expect(region!.months[0]).toMatchObject({ candidates: 17, flaggedBefore: 12, flaggedAfter: 2, desertsBefore: 2, desertsAfter: 1 });
    expect(province!.months[0]).toMatchObject({ candidates: 15, flaggedBefore: 10, flaggedAfter: 0, desertsBefore: 1, desertsAfter: 0 });
    // a desert only counts in a month it has candidates
    expect(region!.months[2]).toMatchObject({ candidates: 6, flaggedBefore: 0, desertsBefore: 0 });
  });

  it('sums months 1-3 and counts a desert once', () => {
    const [region] = run();
    expect(region!.next3).toMatchObject({ candidates: 10, flaggedBefore: 4, flaggedAfter: 0, desertsBefore: 1, desertsAfter: 0 });
  });

  it('utilization is candidates ÷ slots; the proposed center adds its slots; no data stays null', () => {
    const [region, province] = run();
    expect(region!.months[0]!.utilizationBefore).toBeCloseTo(17 / 20);
    expect(region!.months[0]!.utilizationAfter).toBeCloseTo(17 / 30);
    // no slots in the province today: no rate before, the new center's slots after
    expect(province!.months[0]!.utilizationBefore).toBeNull();
    expect(province!.months[0]!.utilizationAfter).toBeCloseTo(15 / 10);
    // month 2 has no slot data at all
    expect(region!.months[2]).toMatchObject({ slots: null, utilizationBefore: null, utilizationAfter: null });
    // months 1-3 use the slots that exist (month 1 only)
    expect(region!.next3).toMatchObject({ slots: 20, pinSlots: 10 });
  });
});
