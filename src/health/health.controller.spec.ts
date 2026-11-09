import { jest } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;
  const queryRaw = jest.fn();
  const redisEnabled = jest.fn();
  const redisPing = jest.fn();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: PrismaService,
          useValue: { $queryRaw: queryRaw },
        },
        {
          provide: RedisService,
          useValue: { isEnabled: redisEnabled, ping: redisPing },
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
    queryRaw.mockReset();
    redisEnabled.mockReset().mockReturnValue(false);
    redisPing.mockReset().mockResolvedValue(true);
  });

  it('returns the API process health status', () => {
    expect(controller.getHealth()).toEqual({ status: 'ok' });
  });

  it('reports readiness when the database is reachable', async () => {
    queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);

    await expect(controller.getReadiness()).resolves.toEqual({
      status: 'ok',
      database: 'up',
      redis: 'disabled',
    });
  });

  it('reports readiness when Redis is reachable', async () => {
    queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);
    redisEnabled.mockReturnValue(true);

    await expect(controller.getReadiness()).resolves.toEqual({
      status: 'ok',
      database: 'up',
      redis: 'up',
    });
  });

  it('reports unavailability when the database check fails', async () => {
    queryRaw.mockRejectedValueOnce(new Error('connection refused'));

    await expect(controller.getReadiness()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('reports unavailability when Redis is unreachable', async () => {
    queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);
    redisEnabled.mockReturnValue(true);
    redisPing.mockResolvedValue(false);

    await expect(controller.getReadiness()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
