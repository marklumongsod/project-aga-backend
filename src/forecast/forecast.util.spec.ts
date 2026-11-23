import {
  addMonthsLabel,
  assertMappingShares,
  groupPlaceMappings,
  monthEpoch,
  monthLabel,
  parseCsv,
  parsePlacesCsv,
  RawForecastRow,
  validateForecastRows,
} from './forecast.util';

const MONTHS = ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04'];

function row(
  level: RawForecastRow['level'],
  placeId: string,
  horizon: number,
  sample: number,
  parent = '',
): RawForecastRow {
  return {
    forecast_month: '2026-10',
    horizon,
    target_month: MONTHS[horizon - 1],
    level,
    place_id: placeId,
    parent_id: parent,
    forecast_sample: sample,
    forecast_real: Math.round(sample / 0.2),
  };
}

function validRows(): RawForecastRow[] {
  const rows: RawForecastRow[] = [];
  for (let h = 1; h <= 6; h++) {
    rows.push(row('national', 'PH', h, 1000));
    rows.push(row('region', '6', h, 1000, 'PH'));
    rows.push(row('province', '45', h, 800, '6'));
    rows.push(row('center', '533', h, 500, '45'));
  }
  return rows;
}

describe('forecast utilities', () => {
  it('adds months across a year boundary', () => {
    expect(addMonthsLabel('2026-12', 1)).toBe('2027-01');
    expect(addMonthsLabel('2026-10', 6)).toBe('2027-04');
    expect(addMonthsLabel('2026-01', -1)).toBe('2025-12');
  });

  it('round-trips a month label through epoch seconds', () => {
    expect(monthLabel(monthEpoch('2026-10'))).toBe('2026-10');
  });

  it('parses quoted CSV fields with commas and escaped quotes', () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
    ]);
  });

  it('parses the place mapping CSV and keeps shares', () => {
    const rows = parsePlacesCsv(
      'level,source_place_id,parent_source_id,name,target_type,target_code,share,note\n' +
        'province,38,15,Maguindanao,province,1908700000,0.75,split\n' +
        'province,38,15,Maguindanao,province,1908800000,0.25,split\n',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].sourcePlaceId).toBe('38');
    expect(rows[1].share).toBe(0.25);
  });

  it('accepts a complete, consistent forecast', () => {
    const result = validateForecastRows(validRows(), 0.2);
    expect(result.forecastMonth).toBe('2026-10');
    expect(result.counts).toEqual({ national: 6, region: 6, province: 6, center: 6 });
    expect(result.places.get('region')?.has('6')).toBe(true);
    expect(result.targetMonths).toEqual(MONTHS);
  });

  it('rejects a horizon outside 1-6', () => {
    const rows = validRows();
    rows[0] = { ...rows[0], horizon: 7 };
    expect(() => validateForecastRows(rows, 0.2)).toThrow(/Invalid horizon/);
  });

  it('rejects a target month that does not match the horizon', () => {
    const rows = validRows();
    rows[0] = { ...rows[0], target_month: '2026-12' };
    expect(() => validateForecastRows(rows, 0.2)).toThrow(/target_month/);
  });

  it('rejects a national total that does not equal the regions', () => {
    const rows = validRows().map((r) => (r.level === 'region' ? { ...r, forecast_sample: 900, forecast_real: 4500 } : r));
    expect(() => validateForecastRows(rows, 0.2)).toThrow(/National/);
  });

  it('rejects a duplicate place/month/horizon', () => {
    const rows = validRows();
    rows.push({ ...rows[0] });
    expect(() => validateForecastRows(rows, 0.2)).toThrow(/Duplicate/);
  });

  it('rejects a real count that is not sample / sample_rate', () => {
    const rows = validRows();
    rows[0] = { ...rows[0], forecast_real: 9999 };
    expect(() => validateForecastRows(rows, 0.2)).toThrow(/forecast_real/);
  });

  it('rejects a place missing a horizon', () => {
    const rows = validRows().filter((r) => !(r.level === 'center' && r.horizon === 3));
    expect(() => validateForecastRows(rows, 0.2)).toThrow(/six horizons/);
  });

  it('requires mapping shares to sum to 1', () => {
    const rows = parsePlacesCsv(
      'level,source_place_id,parent_source_id,name,target_type,target_code,share,note\n' +
        'province,38,15,Maguindanao,province,1908700000,0.75,\n' +
        'province,38,15,Maguindanao,province,1908800000,0.20,\n',
    );
    expect(() => assertMappingShares(groupPlaceMappings(rows))).toThrow(/add up to/);
  });
});
