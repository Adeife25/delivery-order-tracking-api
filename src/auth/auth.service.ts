import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { toPublicUser } from '../users/users.select';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { TokenService } from './token.service';

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
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

    const tokens = await this.tokenService.issueTokenPair(user);

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
      !stored.user.isActive
    ) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const revokedCount =
      await this.tokenService.revokeRefreshToken(refreshToken);
    if (revokedCount !== 1) {
      throw new UnauthorizedException('Refresh token has already been used');
    }

    const tokens = await this.tokenService.issueTokenPair(stored.user);

    return {
      ...tokens,
      user: toPublicUser(stored.user),
    };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokenService.revokeRefreshToken(refreshToken);
  }
}
