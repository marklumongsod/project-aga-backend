import type { RawStep } from './osrm.client';

export interface RouteStep {
  /** "Turn left onto Rizal Street" */
  instruction: string;
  /** metres for this step */
  distanceM: number;
  minutes: number;
  mode: 'driving' | 'ferry' | 'walking';
  /** where the maneuver happens, [lon, lat] */
  location: [number, number];
  /** machine-readable maneuver, e.g. "turn", "left" (for icons) */
  type: string;
  modifier: string | null;
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
export const compass = (bearing: number) => COMPASS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8]!;

const ordinal = (n: number) => ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'][n - 1] ?? `${n}th`;

/** OSRM names can be empty or a bare road reference; say nothing rather than "onto ". */
const onto = (name: string, word = 'onto') => (name ? ` ${word} ${name}` : '');

/** Direction words as people say them: "slight left" -> "bear left". */
function turnWord(modifier: string | undefined): string {
  switch (modifier) {
    case 'left':
    case 'right':
      return `turn ${modifier}`;
    case 'slight left':
      return 'bear left';
    case 'slight right':
      return 'bear right';
    case 'sharp left':
      return 'make a sharp left';
    case 'sharp right':
      return 'make a sharp right';
    case 'uturn':
      return 'make a U-turn';
    default:
      return 'continue straight';
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Plain-English instruction for one OSRM step. OSRM returns maneuver data, not text, so it is built here. */
export function describeStep(step: RawStep): string {
  const { type, modifier, exit, bearing_after } = step.maneuver;
  const name = step.name.trim();

  if (step.mode === 'ferry') {
    // OSRM marks the whole crossing with mode "ferry"; the first step boards it.
    return type === 'arrive' ? 'Leave the ferry' : `Take the ferry${name ? ` (${name})` : ''}`;
  }

  switch (type) {
    case 'depart':
      return `Head ${bearing_after !== undefined ? compass(bearing_after) : 'out'}${onto(name, 'on')}`;
    case 'arrive':
      return modifier === 'left' || modifier === 'right'
        ? `You have arrived. Your destination is on the ${modifier}`
        : 'You have arrived at your destination';
    case 'turn':
    case 'end of road': {
      const lead = type === 'end of road' ? 'At the end of the road, ' : '';
      const act = turnWord(modifier);
      return cap(lead + act) + (modifier === 'straight' ? onto(name, 'on') : onto(name));
    }
    case 'new name':
      return `Continue${onto(name)}`;
    case 'continue':
      return cap(modifier && modifier !== 'straight' ? turnWord(modifier) : 'continue straight') + onto(name, 'on');
    case 'merge':
      return `Merge${modifier ? ` ${modifier.replace('slight ', '')}` : ''}${onto(name)}`;
    case 'on ramp':
      return `Take the ramp${modifier ? ` on the ${modifier.replace(/^(slight|sharp) /, '')}` : ''}${onto(name)}`;
    case 'off ramp':
      return `Take the exit${modifier ? ` on the ${modifier.replace(/^(slight|sharp) /, '')}` : ''}${onto(name)}`;
    case 'fork':
      return `Keep ${modifier?.includes('left') ? 'left' : modifier?.includes('right') ? 'right' : 'straight'} at the fork${onto(name)}`;
    case 'roundabout':
    case 'rotary':
      return `At the ${type === 'rotary' ? 'rotary' : 'roundabout'}, take the ${exit ? `${ordinal(exit)} ` : ''}exit${onto(name)}`;
    case 'roundabout turn':
      return `At the roundabout, ${turnWord(modifier)}${onto(name)}`;
    case 'exit roundabout':
    case 'exit rotary':
      return `Exit the ${type === 'exit rotary' ? 'rotary' : 'roundabout'}${onto(name)}`;
    default:
      return `Continue${onto(name, 'on')}`;
  }
}

/** Steps for display. Zero-length "notification" steps are dropped; consecutive ferry legs are merged into one. */
export function toRouteSteps(raw: RawStep[], base: 'driving' | 'walking' = 'driving'): RouteStep[] {
  const out: RouteStep[] = [];
  for (const s of raw) {
    const ferry = s.mode === 'ferry';
    const prev = out[out.length - 1];
    if (ferry && prev?.mode === 'ferry') {
      prev.distanceM += s.distance;
      prev.minutes += s.duration / 60;
      continue;
    }
    if (!ferry && s.maneuver.type === 'notification' && s.distance === 0) continue;
    out.push({
      instruction: describeStep(s),
      distanceM: Math.round(s.distance),
      minutes: Math.round((s.duration / 60) * 10) / 10,
      mode: ferry ? 'ferry' : base,
      location: s.maneuver.location,
      type: s.maneuver.type,
      modifier: s.maneuver.modifier ?? null,
    });
  }
  return out;
}

/** Closer than this (straight line), people walk: no driving route is offered. */
export const WALK_MAX_M = 500;
/** ...unless the walking route is longer than this (a river or highway in between), then it is a drive. */
export const WALK_MAX_ROUTE_KM = 1.2;
const WALK_METRES_PER_MIN = 80; // ~4.8 km/h
const WALK_DETOUR = 1.3; // paths aren't straight lines

/** Minutes to walk a straight-line distance (paths aren't straight, so a detour factor applies). */
export const walkMinutes = (straightM: number) => Math.max(1, Math.ceil((straightM * WALK_DETOUR) / WALK_METRES_PER_MIN));

/** Initial compass bearing in degrees from a to b. */
export function bearingDeg(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Walking directions for a short trip: one straight-line leg. Roads are not involved. */
export function walkSteps(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  straightM: number,
): { steps: RouteStep[]; minutes: number } {
  const m = Math.round(straightM / 10) * 10;
  const minutes = walkMinutes(straightM);
  const there: [number, number] = [to.lon, to.lat];
  const steps: RouteStep[] = [];
  if (straightM >= 25) {
    steps.push({
      instruction: `Walk about ${m} m ${compass(bearingDeg(from, to))} to the center`,
      distanceM: Math.round(straightM),
      minutes,
      mode: 'walking',
      location: [from.lon, from.lat],
      type: 'depart',
      modifier: null,
    });
  }
  steps.push({
    instruction: straightM >= 25 ? 'You have arrived at your destination' : "You are already at the center's location",
    distanceM: 0,
    minutes: 0,
    mode: 'walking',
    location: there,
    type: 'arrive',
    modifier: null,
  });
  return { steps, minutes };
}
