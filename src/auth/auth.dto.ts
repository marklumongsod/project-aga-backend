import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';
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

export class T2misSsoDto {
  /** ID token issued by the T2MIS identity provider */
  @IsString()
  @IsNotEmpty()
  idToken: string;
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
