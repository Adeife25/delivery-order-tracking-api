import { jest } from '@jest/globals';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UserRole } from '../database/enums';
import type { UsersService } from '../users/users.service';
import type { TokenService } from './token.service';

jest.unstable_mockModule('../database/database.service', () => ({
  DatabaseService: class {},
  isDuplicateKeyError: (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === 11000,
  sessionOptions: () => ({}),
}));
jest.unstable_mockModule('../users/users.service', () => ({
  UsersService: class {},
}));
jest.unstable_mockModule('./token.service', () => ({
  TokenService: class {},
}));

const { AuthService } = await import('./auth.service');

type AsyncMock = jest.Mock<(...args: unknown[]) => Promise<unknown>>;

describe('AuthService', () => {
  let service: InstanceType<typeof AuthService>;
  let usersService: {
    findByEmail: AsyncMock;
    createCustomer: AsyncMock;
  };
  let tokenService: {
    issueTokenPair: AsyncMock;
    verifyRefreshToken: AsyncMock;
    findActiveRefreshToken: AsyncMock;
    revokeRefreshToken: AsyncMock;
  };

  const password = 'strong-password-123';
  const userDoc = {
    _id: '64b7f9d2e1a2b3c4d5e6f700',
    fullName: 'Ada Obi',
    email: 'ada@example.com',
    phoneNumber: null,
    role: UserRole.CUSTOMER,
    isActive: true,
    passwordHash: 'stored-hash',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  const publicUser = {
    id: userDoc._id,
    fullName: userDoc.fullName,
    email: userDoc.email,
    phoneNumber: userDoc.phoneNumber,
    role: userDoc.role,
    isActive: userDoc.isActive,
    createdAt: userDoc.createdAt,
    updatedAt: userDoc.updatedAt,
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
      usersService.findByEmail.mockResolvedValue(userDoc);

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
        ...userDoc,
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
        expect.objectContaining({ id: userDoc._id }),
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
        ...userDoc,
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
        ...userDoc,
        isActive: false,
      });

      await expect(
        service.login({ email: 'ada@example.com', password }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('refresh', () => {
    const storedToken = {
      userId: userDoc._id,
      expiresAt: new Date(Date.now() + 60_000),
      user: userDoc,
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
