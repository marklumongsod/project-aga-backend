import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthUser, CurrentUser, Public } from '../common/auth.decorators';
import { AuthUserDto, LoginDto, LoginResponseDto, T2misSsoDto } from './auth.dto';
import { AuthService } from './auth.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Normal sign-in for CO / RO / PO office accounts. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto): Promise<LoginResponseDto> {
    return this.auth.login(dto.email, dto.password);
  }

  /** Sign in with TESDA SSO (T2MIS). Returns 501 until the T2MIS identity provider is configured. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('sso/t2mis')
  @HttpCode(200)
  t2mis(@Body() dto: T2misSsoDto): Promise<LoginResponseDto> {
    return this.auth.loginWithT2mis(dto.idToken);
  }

  /** The signed-in user and their area scope. */
  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: AuthUser): Promise<AuthUserDto> {
    return this.auth.me(user.id);
  }
}
