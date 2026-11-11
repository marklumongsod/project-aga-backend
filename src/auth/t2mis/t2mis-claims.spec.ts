import { Role } from '../../database/entities/enums';
import {
  AreaLookup,
  claimEmail,
  displayName,
  normalizeRoles,
  parseRoleMap,
  pickRoleTarget,
  provinceCandidates,
  regionCandidates,
  resolveScope,
} from './t2mis-claims';

const R6 = '0600000000';
const NEGROS_OCC = '0604500000';
const R3 = '0300000000';
const NUEVA_ECIJA = '0304900000';
const areas: AreaLookup = {
  regions: new Set([R6, R3]),
  provinces: new Map([
    [NEGROS_OCC, R6],
    [NUEVA_ECIJA, R3],
  ]),
};

describe('T2MIS SSO claims', () => {
  const map = parseRoleMap('CAD=CO, SU=CO, Admin=co ,RO=AUTO,UTPRAS=RO');

  it('parses the role map case-insensitively', () => {
    expect([...map]).toEqual([
      ['cad', 'CO'],
      ['su', 'CO'],
      ['admin', 'CO'],
      ['ro', 'AUTO'],
      ['utpras', 'RO'],
    ]);
  });

  it('reads the role claim as a CSV string or a (nested) array', () => {
    expect(normalizeRoles('RO, AC')).toEqual(['RO', 'AC']);
    expect(normalizeRoles(['RO', ['AC,SU']])).toEqual(['RO', 'AC', 'SU']);
    expect(normalizeRoles(undefined)).toEqual([]);
    expect(normalizeRoles([null, ' ', {}])).toEqual([]);
  });

  it('picks the broadest mapped role and refuses unmapped ones', () => {
    expect(pickRoleTarget(['ro', 'Admin'], map)).toBe(Role.CO);
    expect(pickRoleTarget(['RO'], map)).toBe('AUTO');
    expect(pickRoleTarget(['CAD'], map)).toBe(Role.CO); // CAD is the Central Office
    expect(pickRoleTarget(['RO', 'UTPRAS'], map)).toBe(Role.RO);
    expect(pickRoleTarget(['AC', 'Institution'], map)).toBeNull();
    expect(pickRoleTarget([], map)).toBeNull();
  });

  it('turns region ids of any likely format into PSGC candidates', () => {
    expect(regionCandidates('6')).toEqual([R6]);
    expect(regionCandidates(6)).toEqual([R6]);
    expect(regionCandidates('06')).toEqual([R6]);
    expect(regionCandidates(R6)).toEqual([R6]);
    expect(regionCandidates('060000000')).toEqual([R6]);
    for (const none of ['0', '', 'N/A', null, undefined, '0000000000', '123']) expect(regionCandidates(none)).toEqual([]);
  });

  it('turns province ids of any likely format into PSGC candidates', () => {
    expect(provinceCandidates(NEGROS_OCC, null)).toEqual([NEGROS_OCC]);
    expect(provinceCandidates('064500000', null)).toEqual([NEGROS_OCC]);
    expect(provinceCandidates('06045', null)).toEqual([NEGROS_OCC]);
    expect(provinceCandidates('0645', null)).toEqual([NEGROS_OCC]);
    expect(provinceCandidates('45', R6)).toEqual([NEGROS_OCC]);
    expect(provinceCandidates('45', null)).toEqual([]);
    expect(provinceCandidates('0', R6)).toEqual([]);
  });

  describe('resolveScope', () => {
    it('gives CO the whole country whatever the area claims say', () =>
      expect(resolveScope(Role.CO, '6', '45', areas)).toEqual({
        ok: true,
        scope: { role: Role.CO, regionPsgc: null, provincePsgc: null },
      }));

    it('AUTO is PO when the province resolves, RO when only the region does', () => {
      expect(resolveScope('AUTO', '6', '45', areas)).toEqual({
        ok: true,
        scope: { role: Role.PO, regionPsgc: R6, provincePsgc: NEGROS_OCC },
      });
      expect(resolveScope('AUTO', '06', '0', areas)).toEqual({
        ok: true,
        scope: { role: Role.RO, regionPsgc: R6, provincePsgc: null },
      });
    });

    it('takes the region from the province when RegionId is missing', () =>
      expect(resolveScope('AUTO', '0', NEGROS_OCC, areas)).toEqual({
        ok: true,
        scope: { role: Role.PO, regionPsgc: R6, provincePsgc: NEGROS_OCC },
      }));

    it('RO ignores the province', () =>
      expect(resolveScope(Role.RO, '6', '45', areas)).toEqual({
        ok: true,
        scope: { role: Role.RO, regionPsgc: R6, provincePsgc: null },
      }));

    it('refuses when the area cannot be recognised or does not add up', () => {
      expect(resolveScope('AUTO', '0', '0', areas).ok).toBe(false);
      expect(resolveScope('AUTO', '99', '0', areas).ok).toBe(false);
      expect(resolveScope(Role.PO, '6', '0', areas).ok).toBe(false);
      expect(resolveScope('AUTO', '3', NEGROS_OCC, areas)).toEqual({ ok: false, reason: 'region and province do not match' });
    });
  });

  it('builds a display name from First/Middle/Last, then a non-email name', () => {
    expect(displayName({ name: 'ana@tesda.gov.ph', FirstName: 'Ana', MiddleName: '', LastName: 'Cruz' })).toBe('Ana Cruz');
    expect(displayName({ name: 'Ana Cruz' })).toBe('Ana Cruz');
    expect(displayName({ name: 'ana@tesda.gov.ph' })).toBe('ana@tesda.gov.ph');
    expect(displayName({})).toBe('T2MIS user');
  });

  it('takes the email from email, else from an email-looking name (SSOPortal sends no email claim)', () => {
    expect(claimEmail({ email: 'A@B.PH', name: 'x@y.ph' })).toBe('a@b.ph');
    expect(claimEmail({ name: 'Ana@Tesda.gov.ph' })).toBe('ana@tesda.gov.ph');
    expect(claimEmail({ name: 'Ana Cruz' })).toBeNull();
    expect(claimEmail({})).toBeNull();
  });
});
