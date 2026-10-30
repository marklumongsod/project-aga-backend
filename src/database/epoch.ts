import { ValueTransformer } from 'typeorm';

/**
 * Team convention: epoch time in all date columns. Dates are stored (and returned by the API) as whole seconds since
 * 1970-01-01 UTC, in `bigint` columns. PostgreSQL hands bigint back as a string, so the transformer makes it a number.
 */
export const epochTransformer: ValueTransformer = {
  to: (v?: number | null) => (v === undefined ? undefined : v),
  from: (v?: string | number | null) => (v === null || v === undefined ? null : Number(v)),
};

/** Column default: the current epoch second, truncated like `nowEpoch()` (a bare ::bigint cast would round up). */
export const EPOCH_NOW_SQL = '(FLOOR(EXTRACT(EPOCH FROM now())))::bigint';

export const nowEpoch = () => Math.floor(Date.now() / 1000);
