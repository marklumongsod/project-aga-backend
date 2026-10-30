import { TravelDest, TravelOrigin, TravelTimeModel } from './travel-time.model';

export const pairKey = (cityKey: string, centerId: number) => `${cityKey}|${centerId}`;

/**
 * Road + ferry minutes from a precomputed (city, center) matrix; anything not in it (no route found,
 * or a pin that was just dropped) uses the fallback model. With an empty matrix it is the fallback.
 */
export class MatrixTravelTimeModel implements TravelTimeModel {
  private matrix: ReadonlyMap<string, number> = new Map();
  private builtAt: Date | null = null;

  constructor(private readonly fallback: TravelTimeModel) {}

  get size() {
    return this.matrix.size;
  }

  get name(): string {
    if (!this.matrix.size) return this.fallback.name;
    const day = this.builtAt ? `, built ${this.builtAt.toISOString().slice(0, 10)}` : '';
    return `osrm(road+ferry matrix, ${this.matrix.size} pairs${day}; other pairs: ${this.fallback.name})`;
  }

  setMatrix(matrix: ReadonlyMap<string, number>, builtAt: Date | null = null) {
    this.matrix = matrix;
    this.builtAt = builtAt;
  }

  minutes(from: TravelOrigin, to: TravelDest, km: number): number {
    if (from.key !== null) {
      const m = this.matrix.get(pairKey(from.key, to.id));
      if (m !== undefined) return m;
    }
    return this.fallback.minutes(from, to, km);
  }

  /** Same model plus extra known pairs (e.g. a what-if pin routed live). The base is not changed. */
  withOverlay(overlay: ReadonlyMap<string, number>): TravelTimeModel {
    const base: TravelTimeModel = this;
    return {
      name: this.name,
      minutes(from, to, km) {
        if (from.key !== null) {
          const m = overlay.get(pairKey(from.key, to.id));
          if (m !== undefined) return m;
        }
        return base.minutes(from, to, km);
      },
    };
  }
}
