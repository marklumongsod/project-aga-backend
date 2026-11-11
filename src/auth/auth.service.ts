import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { User } from '../database/entities';
import { AuthUserDto, LoginResponseDto } from './auth.dto';
import { nowEpoch } from '../database/epoch';
import { T2misSsoService } from './t2mis/t2mis-sso.service';

export interface JwtPayload {
  sub: string;
  email: string;
  name: string;
  role: User['role'];
  regionPsgc: string | null;
  provincePsgc: string | null;
}

// Compared against when the email is unknown, so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-password', 12);

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwt: JwtService,
    private readonly sso: T2misSsoService,
  ) {}

  async login(email: string, password: string): Promise<LoginResponseDto> {
    const user = await this.users
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('lower(u.email) = lower(:email)', { email })
      .getOne();
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !user.passwordHash || !ok || !user.isActive) {
      throw new UnauthorizedException('Email or password is incorrect');
    }
    const now = nowEpoch();
    await this.users.update(user.id, { lastLoginAt: now, updatedAt: now });
    user.lastLoginAt = now;
    return this.issue(user);
  }

  /** T2MIS single sign-on (SSOPortal): see T2misSsoService. 501 while T2MIS_SSO_ISSUER is empty. */
  async loginWithT2mis(code: string, codeVerifier: string): Promise<LoginResponseDto> {
    const user = await this.sso.signIn(code, codeVerifier);
    return this.issue(user);
  }

  async me(id: string): Promise<AuthUserDto> {
    const u = await this.users.findOneByOrFail({ id, isActive: true });
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      regionPsgc: u.regionPsgc,
      provincePsgc: u.provincePsgc,
      lastLoginAt: u.lastLoginAt,
    };
  }

  private async issue(u: User): Promise<LoginResponseDto> {
    const payload: JwtPayload = {
      sub: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      regionPsgc: u.regionPsgc,
      provincePsgc: u.provincePsgc,
    };
    const accessToken = await this.jwt.signAsync(payload);
    const { exp, iat } = this.jwt.decode(accessToken) as { exp: number; iat: number };
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: exp - iat,
      user: {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        regionPsgc: u.regionPsgc,
        provincePsgc: u.provincePsgc,
        lastLoginAt: u.lastLoginAt,
      },
    };
  }
}
