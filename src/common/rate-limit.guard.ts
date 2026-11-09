import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { RedisService } from '../redis/redis.service';
import { RATE_LIMIT_KEY } from './rate-limit.decorator';
import {
  defaultRateLimit,
  type RateLimitPolicy,
  type RateLimitPolicyFactory,
} from './throttle.config';

interface Bucket {
  count: number;
  resetAt: number;
}

const MAX_BUCKETS = 10_000;
const REDIS_COMMAND_TIMEOUT_MS = 1000;
const REDIS_RETRY_COOLDOWN_MS = 5000;

const RATE_LIMIT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`;

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly buckets = new Map<string, Bucket>();
  private redisCooldownUntil = 0;
  private redisDown = false;

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const policyFactory = this.reflector.getAllAndOverride<
      RateLimitPolicyFactory | undefined
    >(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);
    const policy: RateLimitPolicy = policyFactory
      ? policyFactory()
      : defaultRateLimit();

    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const key = this.buildKey(context, request);

    const shared = await this.incrementWithRedis(key, policy);
    if (shared) {
      return this.enforce(response, policy, shared.count, shared.resetAt);
    }

    return this.incrementWithMemory(key, policy, response);
  }

  private async incrementWithRedis(
    key: string,
    policy: RateLimitPolicy,
  ): Promise<{ count: number; resetAt: number } | null> {
    const client = this.redis.getClient();
    if (!client || Date.now() < this.redisCooldownUntil) {
      return null;
    }

    const ttlMilliseconds = policy.ttlSeconds * 1000;

    try {
      const result = await this.runRedisCommand(
        client,
        `rl:${key}`,
        ttlMilliseconds,
      );

      const count = Number(result[0]);
      const ttl = Number(result[1]);
      const resetAt = Date.now() + (ttl > 0 ? ttl : ttlMilliseconds);

      this.redisCooldownUntil = 0;

      if (this.redisDown) {
        this.redisDown = false;
        this.logger.log('Redis rate limiting restored');
      }

      return { count, resetAt };
    } catch (error) {
      if (!this.redisDown) {
        this.redisDown = true;
        this.logger.warn(
          `Redis rate limiting unavailable, falling back to in-memory: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }

      this.redisCooldownUntil = Date.now() + REDIS_RETRY_COOLDOWN_MS;
      return null;
    }
  }

  private runRedisCommand(
    client: Redis,
    key: string,
    ttlMilliseconds: number,
  ): Promise<[number, number]> {
    return new Promise<[number, number]>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Redis rate limit command timed out')),
        REDIS_COMMAND_TIMEOUT_MS,
      );

      client
        .eval(RATE_LIMIT_SCRIPT, 1, key, String(ttlMilliseconds))
        .then((result) => {
          clearTimeout(timer);
          resolve(result as [number, number]);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  private incrementWithMemory(
    key: string,
    policy: RateLimitPolicy,
    response: Response,
  ): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      const resetAt = now + policy.ttlSeconds * 1000;
      this.buckets.set(key, { count: 1, resetAt });
      this.pruneExpired(now);
      return this.enforce(response, policy, 1, resetAt);
    }

    bucket.count += 1;
    return this.enforce(response, policy, bucket.count, bucket.resetAt);
  }

  private enforce(
    response: Response,
    policy: RateLimitPolicy,
    count: number,
    resetAt: number,
  ): boolean {
    if (count > policy.limit) {
      const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
      response.setHeader('Retry-After', String(retryAfter));
      this.setHeaders(response, policy, 0, resetAt);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too Many Requests',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    this.setHeaders(response, policy, policy.limit - count, resetAt);
    return true;
  }

  private buildKey(context: ExecutionContext, request: Request): string {
    const ip =
      request.ip ||
      request.socket?.remoteAddress ||
      request.hostname ||
      'unknown';
    return `${context.getClass().name}:${context.getHandler().name}:${ip}`;
  }

  private setHeaders(
    response: Response,
    policy: RateLimitPolicy,
    remaining: number,
    resetAt: number,
  ): void {
    response.setHeader('X-RateLimit-Limit', String(policy.limit));
    response.setHeader('X-RateLimit-Remaining', String(Math.max(0, remaining)));
    response.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
  }

  private pruneExpired(now: number): void {
    if (this.buckets.size <= MAX_BUCKETS) {
      return;
    }

    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}
