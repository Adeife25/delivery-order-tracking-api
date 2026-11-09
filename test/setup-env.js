const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const fileEnv = dotenv.parse(fs.readFileSync(envPath));
  process.env.DATABASE_URL ||= fileEnv.DATABASE_URL;
  process.env.REDIS_URL ||= fileEnv.REDIS_URL;
}

process.env.DATABASE_URL ??=
  'postgresql://postgres:postgres@localhost:5432/delivery_tracking?schema=public';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??=
  'test-access-secret-at-least-thirty-two-characters';
process.env.JWT_REFRESH_SECRET ??=
  'test-refresh-secret-at-least-thirty-two-characters';
process.env.JWT_ACCESS_TTL ??= '900';
process.env.JWT_REFRESH_TTL ??= '604800';
process.env.BCRYPT_ROUNDS ??= '4';
process.env.DEFAULT_DELIVERY_FEE ??= '1500.00';
process.env.DEFAULT_CURRENCY ??= 'NGN';
process.env.PAYSTACK_SECRET_KEY ??=
  'sk_test_paystack_secret_key_for_test_suite';
process.env.PAYSTACK_API_BASE_URL ??= 'https://api.paystack.co';
process.env.LOG_LEVEL ??= 'silent';
process.env.THROTTLE_LIMIT ??= '10000';
process.env.AUTH_THROTTLE_LIMIT ??= '10000';
process.env.PAYMENT_THROTTLE_LIMIT ??= '10000';
process.env.WEBHOOK_THROTTLE_LIMIT ??= '10000';
