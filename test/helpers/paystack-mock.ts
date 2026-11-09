interface MockTransaction {
  reference: string;
  amount: number;
  currency: string;
  email: string;
}

export interface MockVerification {
  status: string;
  amount?: number;
  currency?: string;
  paid_at?: string | null;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export class PaystackMock {
  private readonly transactions = new Map<string, MockTransaction>();
  private readonly verifications = new Map<string, MockVerification>();
  private originalFetch?: typeof fetch;

  async start(): Promise<void> {
    this.originalFetch = globalThis.fetch;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) =>
      this.handle(args[0], args[1])) as typeof fetch;
  }

  async stop(): Promise<void> {
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
    }
  }

  setVerification(reference: string, result: MockVerification): void {
    this.verifications.set(reference, result);
  }

  getTransaction(reference: string): MockTransaction | undefined {
    return this.transactions.get(reference);
  }

  private async handle(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl);

    if (init?.method === 'POST' && url.pathname === '/transaction/initialize') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const reference = String(body.reference ?? '');
      const transaction: MockTransaction = {
        reference,
        amount: Number(body.amount),
        currency: String(body.currency ?? ''),
        email: String(body.email ?? ''),
      };

      this.transactions.set(reference, transaction);

      return jsonResponse(200, {
        status: true,
        data: {
          authorization_url: `https://checkout.paystack.test/${reference}`,
          access_code: `access-${reference}`,
          reference,
        },
      });
    }

    if (
      init?.method === 'GET' &&
      url.pathname.startsWith('/transaction/verify/')
    ) {
      const reference = decodeURIComponent(
        url.pathname.slice('/transaction/verify/'.length),
      );
      const transaction = this.transactions.get(reference);
      const override = this.verifications.get(reference);

      if (!transaction && !override) {
        return jsonResponse(404, {
          status: false,
          message: 'Transaction not found',
        });
      }

      const result: MockVerification = override ?? {
        status: 'success',
        amount: transaction?.amount,
        currency: transaction?.currency,
        paid_at: new Date().toISOString(),
      };

      return jsonResponse(200, {
        status: true,
        data: {
          reference,
          status: result.status,
          amount: result.amount ?? transaction?.amount,
          currency: result.currency ?? transaction?.currency,
          paid_at: result.paid_at ?? null,
        },
      });
    }

    return jsonResponse(404, {
      status: false,
      message: 'Not found',
    });
  }
}
