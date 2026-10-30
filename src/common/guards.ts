import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Role } from '../database/entities';
import { AuthUser, IS_PUBLIC_KEY, ROLES_KEY } from './auth.decorators';

/** Global guard: every route needs a valid access token unless marked @Public(). */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(ctx: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    return isPublic ? true : super.canActivate(ctx);
  }
}

/** Global guard: enforces @Roles(...). */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!roles?.length) return true;
    const user: AuthUser | undefined = ctx.switchToHttp().getRequest().user;
    if (!user || !roles.includes(user.role))
      throw new ForbiddenException('Your role cannot use this feature');
    return true;
  }
}

/**
 * Rate limiting, per who is asking. Signed-in office users are counted per account (they share an office network and so
 * often one public IP, and one dashboard page makes 8-10 calls); everyone else (the public finder, sign-in, anything
 * unauthenticated) is counted per client IP. Must run after JwtAuthGuard so the user is known.
 * The two budgets are the named throttlers in app.module.ts ('office' for signed-in users, 'default' for the rest).
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    if (req.user?.id) return `user:${String(req.user.id)}`;
    return Array.isArray(req.ips) && req.ips.length ? String(req.ips[0]) : String(req.ip);
  }
}
