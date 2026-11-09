const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

type LogLevel = (typeof LOG_LEVELS)[number];

export interface Environment {
  DATABASE_URL: string;
  REDIS_URL?: string;
  NODE_ENV?: string;
  PORT: number;
  LOG_LEVEL: LogLevel;
  TRUST_PROXY: boolean;
  THROTTLE_TTL: number;
  THROTTLE_LIMIT: number;
  AUTH_THROTTLE_TTL: number;
  AUTH_THROTTLE_LIMIT: number;
  PAYMENT_THROTTLE_TTL: number;
  PAYMENT_THROTTLE_LIMIT: number;
  WEBHOOK_THROTTLE_TTL: number;
  WEBHOOK_THROTTLE_LIMIT: number;
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  JWT_ACCESS_TTL: number;
  JWT_REFRESH_TTL: number;
  BCRYPT_ROUNDS: number;
  DEFAULT_DELIVERY_FEE: string;
  DEFAULT_CURRENCY: string;
  PAYSTACK_SECRET_KEY?: string;
  PAYSTACK_API_BASE_URL: string;
  PAYSTACK_CALLBACK_URL?: string;
  SMTP_HOST?: string;
  SMTP_PORT: number;
  SMTP_SECURE: boolean;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_FROM: string;
}

function parseInteger(
  value: unknown,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseSecret(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length < 32) {
    throw new Error(`${name} must be at least 32 characters long`);
  }
  return value;
}

function parseDecimal(
  value: unknown,
  name: string,
  fallback: string,
  max: number,
): string {
  const raw =
    value === undefined || value === null || value === ''
      ? fallback
      : String(value).trim();

  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new Error(
      `${name} must be a non-negative amount with up to 2 decimals`,
    );
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed > max) {
    throw new Error(`${name} must not exceed ${max.toFixed(2)}`);
  }

  return parsed.toFixed(2);
}

function parseOptionalSecret(
  value: unknown,
  name: string,
  minLength: number,
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string' || value.length < minLength) {
    throw new Error(`${name} must be at least ${minLength} characters long`);
  }

  return value;
}

function parseOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value.trim();
}

function parseBoolean(
  value: unknown,
  name: string,
  fallback: boolean,
): boolean {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (value === true || value === 'true' || value === '1') {
    return true;
  }

  if (value === false || value === 'false' || value === '0') {
    return false;
  }

  throw new Error(`${name} must be true or false`);
}

function parseHttpUrl(
  value: unknown,
  name: string,
  fallback?: string,
): string | undefined {
  const raw =
    value === undefined || value === null || value === ''
      ? fallback
      : String(value).trim();

  if (raw === undefined || raw === '') {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must use the http or https protocol`);
  }

  return parsed.toString().replace(/\/$/, '');
}

function parseRedisUrl(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`${name} must be a valid Redis URL`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid Redis URL`);
  }

  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(`${name} must use the redis or rediss protocol`);
  }

  return value;
}

function parseCurrency(value: unknown, name: string, fallback: string): string {
  const raw = (
    value === undefined || value === null || value === ''
      ? fallback
      : String(value)
  )
    .trim()
    .toUpperCase();

  if (!/^[A-Z]{3}$/.test(raw)) {
    throw new Error(`${name} must be a 3-letter currency code`);
  }

  return raw;
}

function parseLogLevel(value: unknown): LogLevel {
  const raw =
    typeof value === 'string' && value.trim().length > 0
      ? value.trim().toLowerCase()
      : 'info';

  if (!LOG_LEVELS.includes(raw as LogLevel)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
  }

  return raw as LogLevel;
}

export function validateEnvironment(
  config: Record<string, unknown>,
): Environment {
  const port = parseInteger(config.PORT, 'PORT', 3000, 1, 65535);

  const databaseUrl = config.DATABASE_URL;
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) {
    throw new Error('DATABASE_URL must be set');
  }

  const nodeEnv =
    typeof config.NODE_ENV === 'string' ? config.NODE_ENV : undefined;
  const redisUrl = parseRedisUrl(config.REDIS_URL, 'REDIS_URL');

  if (nodeEnv === 'production' && !redisUrl) {
    throw new Error('REDIS_URL must be set in production');
  }

  let parsedDatabaseUrl: URL;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL');
  }

  if (
    parsedDatabaseUrl.protocol !== 'postgres:' &&
    parsedDatabaseUrl.protocol !== 'postgresql:'
  ) {
    throw new Error(
      'DATABASE_URL must use the postgres or postgresql protocol',
    );
  }

  return {
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    NODE_ENV: nodeEnv,
    PORT: port,
    LOG_LEVEL: parseLogLevel(config.LOG_LEVEL),
    TRUST_PROXY: parseBoolean(config.TRUST_PROXY, 'TRUST_PROXY', false),
    THROTTLE_TTL: parseInteger(
      config.THROTTLE_TTL,
      'THROTTLE_TTL',
      60,
      1,
      3600,
    ),
    THROTTLE_LIMIT: parseInteger(
      config.THROTTLE_LIMIT,
      'THROTTLE_LIMIT',
      100,
      1,
      100_000,
    ),
    AUTH_THROTTLE_TTL: parseInteger(
      config.AUTH_THROTTLE_TTL,
      'AUTH_THROTTLE_TTL',
      60,
      1,
      3600,
    ),
    AUTH_THROTTLE_LIMIT: parseInteger(
      config.AUTH_THROTTLE_LIMIT,
      'AUTH_THROTTLE_LIMIT',
      10,
      1,
      100_000,
    ),
    PAYMENT_THROTTLE_TTL: parseInteger(
      config.PAYMENT_THROTTLE_TTL,
      'PAYMENT_THROTTLE_TTL',
      60,
      1,
      3600,
    ),
    PAYMENT_THROTTLE_LIMIT: parseInteger(
      config.PAYMENT_THROTTLE_LIMIT,
      'PAYMENT_THROTTLE_LIMIT',
      20,
      1,
      100_000,
    ),
    WEBHOOK_THROTTLE_TTL: parseInteger(
      config.WEBHOOK_THROTTLE_TTL,
      'WEBHOOK_THROTTLE_TTL',
      60,
      1,
      3600,
    ),
    WEBHOOK_THROTTLE_LIMIT: parseInteger(
      config.WEBHOOK_THROTTLE_LIMIT,
      'WEBHOOK_THROTTLE_LIMIT',
      300,
      1,
      100_000,
    ),
    JWT_ACCESS_SECRET: parseSecret(
      config.JWT_ACCESS_SECRET,
      'JWT_ACCESS_SECRET',
    ),
    JWT_REFRESH_SECRET: parseSecret(
      config.JWT_REFRESH_SECRET,
      'JWT_REFRESH_SECRET',
    ),
    JWT_ACCESS_TTL: parseInteger(
      config.JWT_ACCESS_TTL,
      'JWT_ACCESS_TTL',
      900,
      60,
      86400,
    ),
    JWT_REFRESH_TTL: parseInteger(
      config.JWT_REFRESH_TTL,
      'JWT_REFRESH_TTL',
      604800,
      300,
      31536000,
    ),
    BCRYPT_ROUNDS: parseInteger(
      config.BCRYPT_ROUNDS,
      'BCRYPT_ROUNDS',
      12,
      4,
      15,
    ),
    DEFAULT_DELIVERY_FEE: parseDecimal(
      config.DEFAULT_DELIVERY_FEE,
      'DEFAULT_DELIVERY_FEE',
      '0.00',
      9_999_999_999.99,
    ),
    DEFAULT_CURRENCY: parseCurrency(
      config.DEFAULT_CURRENCY,
      'DEFAULT_CURRENCY',
      'NGN',
    ),
    PAYSTACK_SECRET_KEY: parseOptionalSecret(
      config.PAYSTACK_SECRET_KEY,
      'PAYSTACK_SECRET_KEY',
      16,
    ),
    PAYSTACK_API_BASE_URL: parseHttpUrl(
      config.PAYSTACK_API_BASE_URL,
      'PAYSTACK_API_BASE_URL',
      'https://api.paystack.co',
    ) as string,
    PAYSTACK_CALLBACK_URL: parseHttpUrl(
      config.PAYSTACK_CALLBACK_URL,
      'PAYSTACK_CALLBACK_URL',
    ),
    SMTP_HOST: parseOptionalString(config.SMTP_HOST, 'SMTP_HOST'),
    SMTP_PORT: parseInteger(config.SMTP_PORT, 'SMTP_PORT', 587, 1, 65535),
    SMTP_SECURE: parseBoolean(config.SMTP_SECURE, 'SMTP_SECURE', false),
    SMTP_USER: parseOptionalString(config.SMTP_USER, 'SMTP_USER'),
    SMTP_PASS: parseOptionalString(config.SMTP_PASS, 'SMTP_PASS'),
    SMTP_FROM:
      parseOptionalString(config.SMTP_FROM, 'SMTP_FROM') ??
      'no-reply@delivery-tracking.local',
  };
}
