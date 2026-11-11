import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { Role } from '../database/entities';

export class LoginDto {
  /** Office email (accounts are provisioned from T2MIS) */
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  password: string;
}

/** Finishes a T2MIS sign-in: the frontend got `code` on its redirect URI and kept the PKCE verifier it made. */
export class T2misSsoDto {
  /** `code` from SSOPortal's redirect back to the frontend (after the frontend has checked `state`) */
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  code: string;

  /** The PKCE code verifier whose S256 challenge the frontend sent to the authorization endpoint (RFC 7636) */
  @Matches(/^[A-Za-z0-9\-._~]{43,128}$/, { message: 'codeVerifier must be 43-128 characters of A-Z a-z 0-9 - . _ ~' })
  codeVerifier: string;
}

/** How the frontend starts a T2MIS sign-in (authorization code + PKCE S256). */
export class T2misSsoConfigDto {
  /** Send the browser here with client_id, redirect_uri, response_type=code, scope, state, code_challenge */
  authorizationEndpoint: string;
  /** SSOPortal logout (client_id + post_logout_redirect_uri); null if SSOPortal does not advertise one */
  endSessionEndpoint: string | null;
  clientId: string;
  /** Must be sent exactly as given; SSOPortal returns here with ?code=&state= */
  redirectUri: string;
  scope: string;
  @ApiProperty({ enum: ['S256'] })
  codeChallengeMethod: 'S256';
}

export class AuthUserDto {
  id: string;
  email: string;
  name: string;
  @ApiProperty({ enum: Role })
  role: Role;
  /** RO and PO: their region (PSGC) */
  regionPsgc: string | null;
  /** PO: their province (PSGC) */
  provincePsgc: string | null;
  /** when this user last signed in, epoch seconds (for the landing view); null if never */
  lastLoginAt: number | null;
}

export class LoginResponseDto {
  accessToken: string;
  tokenType: 'Bearer';
  /** seconds */
  expiresIn: number;
  user: AuthUserDto;
}
