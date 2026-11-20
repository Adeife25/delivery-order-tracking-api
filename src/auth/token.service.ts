import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import { RefreshTokenModel } from '../database/models';
import type { RefreshTokenDoc } from '../database/views';
import {
  RefreshJwtPayload,
  TokenPair,
  TokenSubject,
} from './types/authenticated-user';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type ActiveRefreshToken = RefreshTokenDoc;

@Injectable()
export class TokenService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;

  constructor(
    config: ConfigService,
    private readonly jwtService: JwtService,
  ) {
    this.accessSecret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
    this.refreshSecret = config.getOrThrow<string>('JWT_REFRESH_SECRET');
    this.accessTtlSeconds = Number(config.getOrThrow<number>('JWT_ACCESS_TTL'));
    this.refreshTtlSeconds = Number(
      config.getOrThrow<number>('JWT_REFRESH_TTL'),
    );
  }

  async issueTokenPair(user: TokenSubject): Promise<TokenPair> {
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(
        {
          sub: user.id,
          email: user.email,
          role: user.role,
          type: 'access',
        },
        {
          secret: this.accessSecret,
          expiresIn: this.accessTtlSeconds,
        },
      ),
      this.jwtService.signAsync(
        {
          sub: user.id,
          type: 'refresh',
          jti: randomUUID(),
        },
        {
          secret: this.refreshSecret,
          expiresIn: this.refreshTtlSeconds,
        },
      ),
    ]);

    await RefreshTokenModel.create({
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + this.refreshTtlSeconds * 1000),
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.accessTtlSeconds,
    };
  }

  async verifyRefreshToken(token: string): Promise<RefreshJwtPayload> {
    try {
      const payload = await this.jwtService.verifyAsync<RefreshJwtPayload>(
        token,
        { secret: this.refreshSecret },
      );

      if (payload.type !== 'refresh' || !payload.sub) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      return payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  async findActiveRefreshToken(
    token: string,
  ): Promise<ActiveRefreshToken | null> {
    return (await RefreshTokenModel.findOne({ tokenHash: hashToken(token) })
      .populate('user')
      .lean()) as unknown as ActiveRefreshToken | null;
  }

  async revokeRefreshToken(token: string): Promise<number> {
    const result = await RefreshTokenModel.updateMany(
      { tokenHash: hashToken(token), revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );

    return result.modifiedCount;
  }
}
