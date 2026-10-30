/**
 * Travel time between a candidate (a city) and an assessment center.
 *
 * Two implementations share this interface:
 *   - EstimatedTravelTimeModel: straight-line km x detour / average speed, plus a ferry allowance when
 *     the trip crosses to another island. Needs no data.
 *   - MatrixTravelTimeModel: real road + ferry durations from an OSRM server (OpenStreetMap), precomputed
 *     per (city, center) pair by `npm run travel:build`. Pairs it doesn't know fall back to the estimate.
 *
 * The engine stays pure and synchronous: it only reads this model. Anything that needs the network
 * (building the matrix, live lookups) lives in OsrmClient / RoutingService, not here.
 */
export interface TravelOrigin {
  /** city key; the matrix is keyed by it. null for a point that isn't a city */
  key: string | null;
  lat: number;
  lon: number;
  islandId: number | null;
}

export interface TravelDest {
  id: number;
  lat: number;
  lon: number;
  islandId: number | null;
}

export interface TravelTimeModel {
  readonly name: string;
  /** minutes from origin to destination; `km` is the straight-line (Haversine) distance */
  minutes(from: TravelOrigin, to: TravelDest, km: number): number;
}

export const TRAVEL_TIME_MODEL = Symbol('TRAVEL_TIME_MODEL');

export class EstimatedTravelTimeModel implements TravelTimeModel {
  readonly name: string;

  constructor(
    private readonly detour = 1.35,
    private readonly speedKmh = 35,
    private readonly ferryMinutes = 90,
  ) {
    this.name = `estimate(detour=${detour}, speed=${speedKmh}km/h, ferry=+${ferryMinutes}min)`;
  }

  minutes(from: TravelOrigin, to: TravelDest, km: number): number {
    const sameIsland = from.islandId !== null && from.islandId === to.islandId;
    return (km * this.detour * 60) / this.speedKmh + (sameIsland ? 0 : this.ferryMinutes);
  }
}
