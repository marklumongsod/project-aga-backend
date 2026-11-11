/**
 * T2MIS SSO (SSOPortal) claims -> an AGA office identity. Pure: no Nest, no DB.
 *
 * SSOPortal tokens carry `sub`, `email`, `name`, `FirstName`/`LastName`, `role` (a comma-separated string or an
 * array; ecosystem roles SU, Admin, CAD, RO, CACS, UTPRAS, AC, Institution) and the account's `RegionId` /
 * `ProvinceId` ('0' or missing when not set). The format of the area ids is not confirmed yet, so
 * `regionCandidates` / `provinceCandidates` accept a 10-digit PSGC, an old 9-digit PSGC or a short PSGC code.
 */
import { Role } from '../../database/entities/enums';

export type RoleTarget = Role | 'AUTO';

/** Broadest first: when a user holds several mapped SSO roles, the widest AGA scope wins. */
const PRECEDENCE: RoleTarget[] = [Role.CO, Role.RO, 'AUTO', Role.PO];

/** `CAD=CO,SU=CO,Admin=CO,RO=AUTO` -> Map(lower-cased SSO role -> target). The format is checked at boot. */
export function parseRoleMap(spec: string): Map<string, RoleTarget> {
  const map = new Map<string, RoleTarget>();
  for (const pair of spec.split(',')) {
    const [sso, target] = pair.split('=').map((s) => s.trim());
    if (!sso || !target) continue;
    map.set(sso.toLowerCase(), target.toUpperCase() as RoleTarget);
  }
  return map;
}

/** `role` claim as SSOPortal sends it: "RO", "RO, AC", ["RO", "AC"] or nested arrays. */
export function normalizeRoles(raw: unknown): string[] {
  const flat = (v: unknown): unknown[] => (Array.isArray(v) ? v.flatMap(flat) : [v]);
  return flat(raw)
    .filter((r): r is string | number => typeof r === 'string' || typeof r === 'number')
    .flatMap((r) => String(r).split(','))
    .map((r) => r.trim())
    .filter(Boolean);
}

/** The AGA role target for these SSO roles, or null when none of them may use AGA. */
export function pickRoleTarget(ssoRoles: string[], map: Map<string, RoleTarget>): RoleTarget | null {
  const targets = new Set(ssoRoles.map((r) => map.get(r.toLowerCase())).filter((t): t is RoleTarget => !!t));
  return PRECEDENCE.find((t) => targets.has(t)) ?? null;
}

/** '0', '', 'N/A', null... mean "not set" in SSOPortal claims. */
function digits(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s) || /^0+$/.test(s)) return null;
  return s;
}

/** Old 9-digit PSGC (RR PP MM BBB) -> 10-digit (RR PPP MM BBB). */
const nineToTen = (s: string) => `${s.slice(0, 2)}0${s.slice(2)}`;

/** PSGC codes the RegionId claim could stand for, most likely first. */
export function regionCandidates(raw: unknown): string[] {
  const s = digits(raw);
  if (!s) return [];
  if (s.length === 10) return [s];
  if (s.length === 9) return [nineToTen(s)];
  if (s.length <= 2) return [`${s.padStart(2, '0')}00000000`];
  return [];
}

/** PSGC codes the ProvinceId claim could stand for, given the region it was sent with (if any). */
export function provinceCandidates(raw: unknown, regionPsgc: string | null): string[] {
  const s = digits(raw);
  if (!s) return [];
  if (s.length === 10) return [s];
  if (s.length === 9) return [nineToTen(s)];
  if (s.length === 5) return [`${s}00000`];
  if (s.length === 4) return [`${s.slice(0, 2)}0${s.slice(2)}00000`];
  if (s.length <= 3 && regionPsgc) return [`${regionPsgc.slice(0, 2)}${s.padStart(3, '0')}00000`];
  return [];
}

export interface AreaLookup {
  regions: ReadonlySet<string>;
  /** province PSGC -> its region PSGC */
  provinces: ReadonlyMap<string, string>;
}

export interface ResolvedScope {
  role: Role;
  regionPsgc: string | null;
  provincePsgc: string | null;
}

export type ScopeResult = { ok: true; scope: ResolvedScope } | { ok: false; reason: string };

/** AGA role and area scope for a role target and the account's RegionId / ProvinceId claims. */
export function resolveScope(
  target: RoleTarget,
  regionRaw: unknown,
  provinceRaw: unknown,
  areas: AreaLookup,
): ScopeResult {
  if (target === Role.CO) return { ok: true, scope: { role: Role.CO, regionPsgc: null, provincePsgc: null } };

  const claimedRegion = regionCandidates(regionRaw).find((r) => areas.regions.has(r)) ?? null;
  const province = provinceCandidates(provinceRaw, claimedRegion).find((p) => areas.provinces.has(p)) ?? null;
  const provinceRegion = province ? areas.provinces.get(province)! : null;
  if (claimedRegion && provinceRegion && claimedRegion !== provinceRegion) {
    return { ok: false, reason: 'region and province do not match' };
  }
  const region = claimedRegion ?? provinceRegion;

  const wantPo = target === Role.PO || (target === 'AUTO' && province);
  if (wantPo) {
    if (!province) return { ok: false, reason: 'no province AGA recognises' };
    return { ok: true, scope: { role: Role.PO, regionPsgc: provinceRegion, provincePsgc: province } };
  }
  if (!region) return { ok: false, reason: 'no region AGA recognises' };
  return { ok: true, scope: { role: Role.RO, regionPsgc: region, provincePsgc: null } };
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Display name from the claims SSOPortal sends. SSOPortal puts the T2MIS user name (usually the login email) in
 * `name`, so First/Middle/Last come first and an email-looking `name` is used only as a last resort.
 */
export function displayName(c: Record<string, unknown>): string {
  const full = [str(c.FirstName), str(c.MiddleName), str(c.LastName)].filter(Boolean).join(' ');
  const name = str(c.name);
  return full || (name && !EMAIL.test(name) ? name : '') || name || str(c.preferred_username) || 'T2MIS user';
}

/** The account email: the `email` claim, else `name` / `preferred_username` when it is an email (SSOPortal sends no `email`). */
export function claimEmail(c: Record<string, unknown>): string | null {
  const found = [str(c.email), str(c.name), str(c.preferred_username)].find((v) => EMAIL.test(v));
  return found ? found.toLowerCase() : null;
}
