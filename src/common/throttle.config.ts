export interface RateLimitPolicy {
  limit: number;
  ttlSeconds: number;
}

export type RateLimitPolicyFactory = () => RateLimitPolicy;

function envInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function rateLimit(
  limitEnv: string,
  ttlEnv: string,
  defaultLimit: number,
  defaultTtlSeconds: number,
): RateLimitPolicyFactory {
  return () => ({
    limit: envInteger(limitEnv, defaultLimit),
    ttlSeconds: envInteger(ttlEnv, defaultTtlSeconds),
  });
}

export const authRateLimit = rateLimit(
  'AUTH_THROTTLE_LIMIT',
  'AUTH_THROTTLE_TTL',
  10,
  60,
);

export const paymentRateLimit = rateLimit(
  'PAYMENT_THROTTLE_LIMIT',
  'PAYMENT_THROTTLE_TTL',
  20,
  60,
);

export const webhookRateLimit = rateLimit(
  'WEBHOOK_THROTTLE_LIMIT',
  'WEBHOOK_THROTTLE_TTL',
  300,
  60,
);

export const defaultRateLimit = rateLimit(
  'THROTTLE_LIMIT',
  'THROTTLE_TTL',
  100,
  60,
);
