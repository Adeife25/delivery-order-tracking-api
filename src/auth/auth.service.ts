import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { isDuplicateKeyError } from '../database/database.service';
import type { UserDoc } from '../database/views';
import { UsersService } from '../users/users.service';
import { toPublicUser } from '../users/users.select';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { TokenService } from './token.service';
import type { TokenSubject } from './types/authenticated-user';

function isUniqueConstraintError(error: unknown): boolean {
  return isDuplicateKeyError(error);
}

function toTokenSubject(user: UserDoc): TokenSubject {
  return {
    id: user._id,
    email: user.email,
    role: user.role,
  };
}

@Injectable()
export class AuthService {
  private readonly bcryptRounds: number;

  constructor(
    config: ConfigService,
    private readonly usersService: UsersService,
    private readonly tokenService: TokenService,
  ) {
    this.bcryptRounds = Number(config.getOrThrow<number>('BCRYPT_ROUNDS'));
  }

  async register(dto: RegisterDto) {
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, this.bcryptRounds);

    try {
      const user = await this.usersService.createCustomer({
        fullName: dto.fullName,
        email: dto.email,
        passwordHash,
        phoneNumber: dto.phoneNumber,
      });

      return { user };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          'An account with this email already exists',
        );
      }
      throw error;
    }
  }

  async login(dto: LoginDto) {
    const user = await this.usersService.findByEmail(dto.email);

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const tokens = await this.tokenService.issueTokenPair(toTokenSubject(user));

    return {
      ...tokens,
      user: toPublicUser(user),
    };
  }

  async refresh(refreshToken: string) {
    const payload = await this.tokenService.verifyRefreshToken(refreshToken);
    const stored = await this.tokenService.findActiveRefreshToken(refreshToken);

    if (
      !stored ||
      stored.userId !== payload.sub ||
      stored.expiresAt <= new Date() ||
      !stored.user?.isActive
    ) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const revokedCount =
      await this.tokenService.revokeRefreshToken(refreshToken);
    if (revokedCount !== 1) {
      throw new UnauthorizedException('Refresh token has already been used');
    }

    const user = stored.user as UserDoc;
    const tokens = await this.tokenService.issueTokenPair(toTokenSubject(user));

    return {
      ...tokens,
      user: toPublicUser(user),
    };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokenService.revokeRefreshToken(refreshToken);
  }
}
