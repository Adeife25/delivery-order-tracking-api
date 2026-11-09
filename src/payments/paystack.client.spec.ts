import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { PaystackClient } from './paystack.client';

function createClient(secretKey?: string): PaystackClient {
  const config = {
    get: (key: string) =>
      key === 'PAYSTACK_SECRET_KEY' ? secretKey : undefined,
    getOrThrow: (key: string) => {
      if (key === 'PAYSTACK_API_BASE_URL') {
        return 'https://api.paystack.co';
      }

      throw new Error(`${key} is not configured`);
    },
  } as unknown as ConfigService;

  return new PaystackClient(config);
}

describe('PaystackClient', () => {
  const secret = 'sk_test_paystack_secret_key_for_test_suite';
  const payload = Buffer.from(
    JSON.stringify({
      event: 'charge.success',
      data: { reference: 'PAY-TEST-REFERENCE' },
    }),
  );

  it('accepts a valid HMAC SHA512 webhook signature', () => {
    const signature = createHmac('sha512', secret)
      .update(payload)
      .digest('hex');

    expect(
      createClient(secret).verifyWebhookSignature(payload, signature),
    ).toBe(true);
  });

  it('rejects altered payloads and invalid signatures', () => {
    const signature = createHmac('sha512', secret)
      .update(payload)
      .digest('hex');
    const altered = Buffer.from(
      payload.toString('utf8').replace('PAY-TEST', 'PAY-FAKE'),
    );

    expect(
      createClient(secret).verifyWebhookSignature(altered, signature),
    ).toBe(false);
    expect(
      createClient(secret).verifyWebhookSignature(payload, 'not-a-signature'),
    ).toBe(false);
  });

  it('reports an unconfigured provider and rejects signatures', () => {
    const client = createClient();

    expect(client.isConfigured()).toBe(false);
    expect(client.verifyWebhookSignature(payload, 'signature')).toBe(false);
  });
});
