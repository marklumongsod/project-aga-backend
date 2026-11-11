import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthUser, CurrentUser, Public } from '../common/auth.decorators';
import { AuthUserDto, LoginDto, LoginResponseDto, T2misSsoConfigDto, T2misSsoDto } from './auth.dto';
import { AuthService } from './auth.service';
import { T2misSsoService } from './t2mis/t2mis-sso.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sso: T2misSsoService,
  ) {}

  /** Normal sign-in for CO / RO / PO office accounts. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto): Promise<LoginResponseDto> {
    return this.auth.login(dto.email, dto.password);
  }

  /** How to start a TESDA SSO (T2MIS) sign-in: authorization endpoint, client id, redirect URI, scope. 501 until configured. */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('sso/t2mis')
  t2misConfig(): Promise<T2misSsoConfigDto> {
    return this.sso.publicConfig();
  }

  /**
   * Finish a TESDA SSO (T2MIS) sign-in: exchanges the authorization code with SSOPortal, verifies the tokens and
   * returns an AGA access token like /auth/login. 401 bad or expired code, 403 role or area not allowed, 501 not configured.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('sso/t2mis')
  @HttpCode(200)
  t2mis(@Body() dto: T2misSsoDto): Promise<LoginResponseDto> {
    return this.auth.loginWithT2mis(dto.code, dto.codeVerifier);
  }

  /** The signed-in user and their area scope. */
  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: AuthUser): Promise<AuthUserDto> {
    return this.auth.me(user.id);
  }
}
