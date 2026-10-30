import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Role } from '../database/entities';

export const IS_PUBLIC_KEY = 'isPublic';
/** Route needs no login (public learner finder, health, login). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
/** Restrict a route to some office roles. Without it any signed-in office user may call it. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** The signed-in office user, as carried in the access token. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  regionPsgc: string | null;
  provincePsgc: string | null;
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);
