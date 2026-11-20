import { jest } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { RedisService } from '../redis/redis.service';

const databasePing = jest.fn(async () => undefined);
const redisEnabled = jest.fn(() => false);
const redisPing = jest.fn(async () => true);

jest.unstable_mockModule('../database/database.service', () => ({
  DatabaseService: class {},
  isDuplicateKeyError: () => false,
  sessionOptions: () => ({}),
}));

const { DatabaseService } = await import('../database/database.service');
const { HealthController } = await import('./health.controller');

describe('HealthController', () => {
  let controller: InstanceType<typeof HealthController>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: DatabaseService,
          useValue: { ping: databasePing },
        },
        {
          provide: RedisService,
          useValue: { isEnabled: redisEnabled, ping: redisPing },
        },
      ],
    }).compile();

    controller =
      module.get<InstanceType<typeof HealthController>>(HealthController);
    databasePing.mockReset().mockResolvedValue(undefined);
    redisEnabled.mockReset().mockReturnValue(false);
    redisPing.mockReset().mockResolvedValue(true);
  });

  it('returns the API process health status', () => {
    expect(controller.getHealth()).toEqual({ status: 'ok' });
  });

  it('reports readiness when the database is reachable', async () => {
    await expect(controller.getReadiness()).resolves.toEqual({
      status: 'ok',
      database: 'up',
      redis: 'disabled',
    });
    expect(databasePing).toHaveBeenCalledTimes(1);
  });

  it('reports readiness when Redis is reachable', async () => {
    redisEnabled.mockReturnValue(true);

    await expect(controller.getReadiness()).resolves.toEqual({
      status: 'ok',
      database: 'up',
      redis: 'up',
    });
  });

  it('reports unavailability when the database check fails', async () => {
    databasePing.mockRejectedValueOnce(new Error('connection refused'));

    await expect(controller.getReadiness()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('reports unavailability when Redis is unreachable', async () => {
    redisEnabled.mockReturnValue(true);
    redisPing.mockResolvedValue(false);

    await expect(controller.getReadiness()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
