import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({ description: 'The refresh token issued at login or refresh' })
  @IsString()
  @MinLength(1)
  refreshToken: string;
}
