import { jest } from '@jest/globals';
import {
  HttpException,
  HttpStatus,
  type ExecutionContext,
} from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Redis } from 'ioredis';
import type { RedisService } from '../redis/redis.service';
import { RateLimitGuard } from './rate-limit.guard';
import type { RateLimitPolicy } from './throttle.config';

function createContext(): {
  context: ExecutionContext;
  response: { setHeader: jest.Mock };
} {
  class TestController {}
  function testHandler(): void {}

  const request = {
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    hostname: 'localhost',
  } as unknown as Request;
  const response = { setHeader: jest.fn() };

  const context = {
    getType: () => 'http',
    getClass: () => TestController,
    getHandler: () => testHandler,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;

  return {
    context,
    response: response as unknown as { setHeader: jest.Mock },
  };
}

function createGuard(
  policy: RateLimitPolicy,
  evalMock: jest.Mock,
): RateLimitGuard {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(() => policy),
  } as unknown as Reflector;
  const client = { eval: evalMock } as unknown as Redis;
  const redis = {
    getClient: jest.fn().mockReturnValue(client),
  } as unknown as RedisService;

  return new RateLimitGuard(reflector, redis);
}

describe('RateLimitGuard', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses Redis counters and sets rate limit headers', async () => {
    const evalMock = jest.fn().mockResolvedValue([1, 60_000]);
    const guard = createGuard({ limit: 2, ttlSeconds: 60 }, evalMock);
    const { context, response } = createContext();

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(evalMock).toHaveBeenCalledWith(
      expect.stringContaining('INCR'),
      1,
      'rl:TestController:testHandler:127.0.0.1',
      '60000',
    );
    expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '2');
    expect(response.setHeader).toHaveBeenCalledWith(
      'X-RateLimit-Remaining',
      '1',
    );
  });

  it('rejects requests over the Redis limit', async () => {
    const evalMock = jest.fn().mockResolvedValue([2, 60_000]);
    const guard = createGuard({ limit: 1, ttlSeconds: 60 }, evalMock);
    const { context } = createContext();

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });

  it('skips Redis during cooldown and probes again afterwards', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const evalMock = jest
      .fn()
      .mockRejectedValueOnce(new Error('Redis unavailable'))
      .mockResolvedValue([1, 60_000]);
    const guard = createGuard({ limit: 2, ttlSeconds: 60 }, evalMock);
    const { context } = createContext();

    await expect(guard.canActivate(context)).resolves.toBe(true);
    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(evalMock).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(5001);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(evalMock).toHaveBeenCalledTimes(2);
  });

  it('enforces the in-memory limit while Redis is unavailable', async () => {
    const evalMock = jest.fn().mockRejectedValue(new Error('Redis down'));
    const guard = createGuard({ limit: 1, ttlSeconds: 60 }, evalMock);
    const { context } = createContext();

    await expect(guard.canActivate(context)).resolves.toBe(true);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      HttpException,
    );
  });
});
