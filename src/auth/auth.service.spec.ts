import { jest } from '@jest/globals';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UserRole } from '../generated/prisma/enums';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';

describe('AuthService', () => {
  let service: AuthService;
  let usersService: {
    findByEmail: jest.Mock;
    createCustomer: jest.Mock;
  };
  let tokenService: {
    issueTokenPair: jest.Mock;
    verifyRefreshToken: jest.Mock;
    findActiveRefreshToken: jest.Mock;
    revokeRefreshToken: jest.Mock;
  };

  const password = 'strong-password-123';
  const publicUser = {
    id: '11111111-1111-4111-8111-111111111111',
    fullName: 'Ada Obi',
    email: 'ada@example.com',
    phoneNumber: null,
    role: UserRole.CUSTOMER,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  const tokenPair = {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresIn: 900,
  };

  beforeAll(async () => {
    const config = {
      getOrThrow: jest.fn((key: string) =>
        key === 'BCRYPT_ROUNDS' ? 4 : undefined,
      ),
    } as unknown as ConfigService;

    usersService = {
      findByEmail: jest.fn(),
      createCustomer: jest.fn(),
    };
    tokenService = {
      issueTokenPair: jest.fn(),
      verifyRefreshToken: jest.fn(),
      findActiveRefreshToken: jest.fn(),
      revokeRefreshToken: jest.fn(),
    };

    service = new AuthService(
      config,
      usersService as unknown as UsersService,
      tokenService as unknown as TokenService,
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('register', () => {
    it('hashes the password and creates a customer', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      usersService.createCustomer.mockResolvedValue(publicUser);

      const result = await service.register({
        fullName: 'Ada Obi',
        email: 'ada@example.com',
        password,
      });

      const createArgs = usersService.createCustomer.mock.calls[0][0] as {
        passwordHash: string;
      };
      expect(createArgs.passwordHash).not.toBe(password);
      await expect(
        bcrypt.compare(password, createArgs.passwordHash),
      ).resolves.toBe(true);
      expect(result).toEqual({ user: publicUser });
    });

    it('rejects an existing email', async () => {
      usersService.findByEmail.mockResolvedValue(publicUser);

      await expect(
        service.register({
          fullName: 'Ada Obi',
          email: 'ada@example.com',
          password,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(usersService.createCustomer).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('returns tokens and a public user for valid credentials', async () => {
      const passwordHash = await bcrypt.hash(password, 4);
      usersService.findByEmail.mockResolvedValue({
        ...publicUser,
        passwordHash,
      });
      tokenService.issueTokenPair.mockResolvedValue(tokenPair);

      const result = await service.login({
        email: 'ada@example.com',
        password,
      });

      expect(result).toEqual({ ...tokenPair, user: publicUser });
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(tokenService.issueTokenPair).toHaveBeenCalledWith(
        expect.objectContaining({ id: publicUser.id }),
      );
    });

    it('rejects an unknown email', async () => {
      usersService.findByEmail.mockResolvedValue(null);

      await expect(
        service.login({ email: 'ada@example.com', password }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a wrong password', async () => {
      const passwordHash = await bcrypt.hash(password, 4);
      usersService.findByEmail.mockResolvedValue({
        ...publicUser,
        passwordHash,
      });

      await expect(
        service.login({
          email: 'ada@example.com',
          password: 'wrong-password',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects an inactive account', async () => {
      usersService.findByEmail.mockResolvedValue({
        ...publicUser,
        isActive: false,
      });

      await expect(
        service.login({ email: 'ada@example.com', password }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('refresh', () => {
    const storedToken = {
      userId: publicUser.id,
      expiresAt: new Date(Date.now() + 60_000),
      user: publicUser,
    };

    it('rotates a valid refresh token', async () => {
      tokenService.verifyRefreshToken.mockResolvedValue({
        sub: publicUser.id,
        type: 'refresh',
      });
      tokenService.findActiveRefreshToken.mockResolvedValue(storedToken);
      tokenService.revokeRefreshToken.mockResolvedValue(1);
      tokenService.issueTokenPair.mockResolvedValue(tokenPair);

      const result = await service.refresh('old-refresh-token');

      expect(tokenService.revokeRefreshToken).toHaveBeenCalledWith(
        'old-refresh-token',
      );
      expect(result).toEqual({ ...tokenPair, user: publicUser });
    });

    it('rejects a refresh token that was already rotated', async () => {
      tokenService.verifyRefreshToken.mockResolvedValue({
        sub: publicUser.id,
        type: 'refresh',
      });
      tokenService.findActiveRefreshToken.mockResolvedValue(storedToken);
      tokenService.revokeRefreshToken.mockResolvedValue(0);

      await expect(service.refresh('old-refresh-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects a refresh token belonging to another user', async () => {
      tokenService.verifyRefreshToken.mockResolvedValue({
        sub: 'another-user',
        type: 'refresh',
      });
      tokenService.findActiveRefreshToken.mockResolvedValue(storedToken);

      await expect(service.refresh('old-refresh-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects an expired refresh token', async () => {
      tokenService.verifyRefreshToken.mockResolvedValue({
        sub: publicUser.id,
        type: 'refresh',
      });
      tokenService.findActiveRefreshToken.mockResolvedValue({
        ...storedToken,
        expiresAt: new Date(Date.now() - 60_000),
      });

      await expect(service.refresh('old-refresh-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  it('revokes the refresh token on logout', async () => {
    tokenService.revokeRefreshToken.mockResolvedValue(1);

    await service.logout('refresh-token');

    expect(tokenService.revokeRefreshToken).toHaveBeenCalledWith(
      'refresh-token',
    );
  });
});
