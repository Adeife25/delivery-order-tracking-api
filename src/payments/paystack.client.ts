import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

export interface PaystackInitializeInput {
  email: string;
  amount: number;
  currency: string;
  reference: string;
  callbackUrl?: string;
  metadata: Record<string, string>;
}

export interface PaystackInitializeResult {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export interface PaystackTransaction {
  reference: string;
  status: string;
  amount: number;
  currency: string;
  paid_at?: string | null;
  gateway_response?: string | null;
}

interface PaystackResponseBody {
  status?: boolean;
  message?: string;
  data?: unknown;
}

export class PaystackProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaystackProviderError';
  }
}

@Injectable()
export class PaystackClient {
  private readonly secretKey?: string;
  private readonly baseUrl: string;
  private readonly callbackUrl?: string;
  private readonly timeoutMs = 10_000;

  constructor(config: ConfigService) {
    this.secretKey = config.get<string>('PAYSTACK_SECRET_KEY');
    this.baseUrl = config.getOrThrow<string>('PAYSTACK_API_BASE_URL');
    this.callbackUrl = config.get<string>('PAYSTACK_CALLBACK_URL');
  }

  isConfigured(): boolean {
    return Boolean(this.secretKey);
  }

  async initialize(
    input: PaystackInitializeInput,
  ): Promise<PaystackInitializeResult> {
    const data = await this.request<PaystackInitializeResult>(
      '/transaction/initialize',
      {
        method: 'POST',
        body: JSON.stringify({
          email: input.email,
          amount: input.amount,
          currency: input.currency,
          reference: input.reference,
          callback_url: input.callbackUrl ?? this.callbackUrl,
          metadata: input.metadata,
        }),
      },
    );

    if (
      typeof data?.authorization_url !== 'string' ||
      typeof data?.access_code !== 'string' ||
      typeof data?.reference !== 'string'
    ) {
      throw new PaystackProviderError(
        'Payment provider returned an invalid initialization response',
      );
    }

    return data;
  }

  async verify(reference: string): Promise<PaystackTransaction> {
    const data = await this.request<PaystackTransaction>(
      `/transaction/verify/${encodeURIComponent(reference)}`,
      { method: 'GET' },
    );

    if (
      typeof data?.reference !== 'string' ||
      typeof data?.status !== 'string' ||
      typeof data?.amount !== 'number' ||
      typeof data?.currency !== 'string'
    ) {
      throw new PaystackProviderError(
        'Payment provider returned an invalid verification response',
      );
    }

    return data;
  }

  verifyWebhookSignature(payload: Buffer, signature: string): boolean {
    if (!this.secretKey || !signature) {
      return false;
    }

    const expected = createHmac('sha512', this.secretKey)
      .update(payload)
      .digest('hex');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const providedBuffer = Buffer.from(signature, 'utf8');

    return (
      expectedBuffer.length === providedBuffer.length &&
      timingSafeEqual(expectedBuffer, providedBuffer)
    );
  }

  private async request<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: string },
  ): Promise<T> {
    if (!this.secretKey) {
      throw new PaystackProviderError('Payment provider is not configured');
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: init.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new PaystackProviderError('Unable to reach payment provider');
    }

    const body = (await response
      .json()
      .catch(() => null)) as PaystackResponseBody | null;

    if (!response.ok || !body?.status || body.data === undefined) {
      throw new PaystackProviderError(
        body?.message ?? 'Payment provider request failed',
      );
    }

    return body.data as T;
  }
}
