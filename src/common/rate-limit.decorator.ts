import { SetMetadata } from '@nestjs/common';
import type { RateLimitPolicyFactory } from './throttle.config';

export const RATE_LIMIT_KEY = 'rate-limit-policy';

export const RateLimit = (policy: RateLimitPolicyFactory) =>
  SetMetadata(RATE_LIMIT_KEY, policy);
