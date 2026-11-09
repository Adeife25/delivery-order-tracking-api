import { INestApplication } from '@nestjs/common';
import { createHmac } from 'crypto';
import { App } from 'supertest/types';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { PaystackMock } from './helpers/paystack-mock';
import {
  createTestApp,
  registerCustomer,
  resetDatabase,
} from './helpers/test-app';

interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string };
}

interface OrderResponse {
  id: string;
  deliveryFee: string;
  currency: string;
  status: string;
}

describe('Payment endpoints (e2e)', () => {
  const password = 'strong-password-123';
  const paystackSecret = 'sk_test_paystack_secret_key_for_test_suite';

  let app: INestApplication<App>;
  let prisma: PrismaService;
  let paystack: PaystackMock;

  let customer: Session;
  let other: Session;
  let admin: Session;

  let order: OrderResponse;
  let firstPaymentId: string;
  let firstReference: string;

  const api = () => request(app.getHttpServer());
  const auth = (session: Session) => ({
    Authorization: `Bearer ${session.accessToken}`,
  });
  const orderPayload = {
    pickupAddress: '12 Marina Road, Lagos',
    deliveryAddress: '45 Adeola Odeku Street, Lagos',
    packageDescription: 'Small sealed carton',
    deliveryInstructions: 'Call on arrival',
  };

  function minorUnits(value: string | number): number {
    return Math.round(Number(value) * 100);
  }

  async function createOrder(): Promise<OrderResponse> {
    const response = await api()
      .post('/api/v1/orders')
      .set(auth(customer))
      .send(orderPayload)
      .expect(201);

    return response.body as OrderResponse;
  }

  async function initiatePayment(orderId: string) {
    return api()
      .post(`/api/v1/orders/${orderId}/payments`)
      .set(auth(customer))
      .expect(201);
  }

  function signedWebhook(payload: Record<string, unknown>): {
    raw: Buffer;
    signature: string;
  } {
    const raw = Buffer.from(JSON.stringify(payload));
    const signature = createHmac('sha512', paystackSecret)
      .update(raw)
      .digest('hex');

    return { raw, signature };
  }

  function sendWebhook(
    payload: Record<string, unknown>,
    signature: string,
    expectedStatus = 200,
  ) {
    const { raw } = signedWebhook(payload);

    return api()
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(raw.toString('utf8'))
      .expect(expectedStatus);
  }

  beforeAll(async () => {
    paystack = new PaystackMock();
    await paystack.start();

    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
    await resetDatabase(prisma);

    customer = await registerCustomer(app, {
      fullName: 'Paying Customer',
      email: 'payer@example.com',
      password,
    });
    other = await registerCustomer(app, {
      fullName: 'Other Customer',
      email: 'payment-other@example.com',
      password,
    });
    await registerCustomer(app, {
      fullName: 'Payment Admin',
      email: 'payment-admin@example.com',
      password,
    });

    await prisma.user.update({
      where: { email: 'payment-admin@example.com' },
      data: { role: 'ADMIN' },
    });

    const login = await api()
      .post('/api/v1/auth/login')
      .send({ email: 'payment-admin@example.com', password })
      .expect(200);
    admin = login.body as Session;
  });

  afterAll(async () => {
    await app.close();
    await paystack.stop();
  });

  it('restricts payment initiation to the order owner', async () => {
    order = await createOrder();

    await api().post(`/api/v1/orders/${order.id}/payments`).expect(401);

    await api()
      .post(`/api/v1/orders/${order.id}/payments`)
      .set(auth(other))
      .expect(404);
  });

  it('initializes one pending payment and exposes it only to authorised users', async () => {
    const response = await initiatePayment(order.id);

    firstPaymentId = response.body.payment.id as string;
    firstReference = response.body.reference as string;

    expect(response.body.payment).toMatchObject({
      orderId: order.id,
      provider: 'paystack',
      providerReference: firstReference,
      status: 'PENDING',
      currency: order.currency,
    });
    expect(Number(response.body.payment.amount)).toBe(
      Number(order.deliveryFee),
    );
    expect(response.body.accessCode).toBe(`access-${firstReference}`);
    expect(response.body.authorizationUrl).toBe(
      `https://checkout.paystack.test/${firstReference}`,
    );

    const providerTransaction = paystack.getTransaction(firstReference);
    expect(providerTransaction).toMatchObject({
      amount: minorUnits(order.deliveryFee),
      currency: order.currency,
      email: 'payer@example.com',
    });

    await api()
      .get(`/api/v1/payments/${firstPaymentId}`)
      .set(auth(customer))
      .expect(200);

    await api()
      .get(`/api/v1/payments/${firstPaymentId}`)
      .set(auth(admin))
      .expect(200);

    await api()
      .get(`/api/v1/payments/${firstPaymentId}`)
      .set(auth(other))
      .expect(404);

    await api()
      .post(`/api/v1/orders/${order.id}/payments`)
      .set(auth(customer))
      .expect(409);
  });

  it('trusts provider verification, retries failed attempts, and confirms the order once', async () => {
    paystack.setVerification(firstReference, { status: 'failed' });

    const failed = await api()
      .post('/api/v1/payments/verify')
      .set(auth(customer))
      .send({ reference: firstReference })
      .expect(200);

    expect(failed.body.status).toBe('FAILED');

    const pendingOrder = await api()
      .get(`/api/v1/orders/${order.id}`)
      .set(auth(customer))
      .expect(200);
    expect(pendingOrder.body.status).toBe('PENDING_PAYMENT');

    const retry = await initiatePayment(order.id);
    const retryReference = retry.body.reference as string;

    paystack.setVerification(retryReference, {
      status: 'success',
      amount: minorUnits(order.deliveryFee),
      currency: order.currency,
      paid_at: '2026-11-04T10:00:00.000Z',
    });

    const verified = await api()
      .post('/api/v1/payments/verify')
      .set(auth(customer))
      .send({ reference: retryReference })
      .expect(200);

    expect(verified.body.status).toBe('SUCCEEDED');
    expect(verified.body.paidAt).toBe('2026-11-04T10:00:00.000Z');

    const confirmedOrder = await api()
      .get(`/api/v1/orders/${order.id}`)
      .set(auth(customer))
      .expect(200);
    expect(confirmedOrder.body.status).toBe('CONFIRMED');

    const repeated = await api()
      .post('/api/v1/payments/verify')
      .set(auth(customer))
      .send({ reference: retryReference })
      .expect(200);
    expect(repeated.body.status).toBe('SUCCEEDED');

    await api()
      .post(`/api/v1/orders/${order.id}/payments`)
      .set(auth(customer))
      .expect(409);
  });

  it('rejects provider success when the paid amount does not match', async () => {
    const mismatchOrder = await createOrder();
    const initiation = await initiatePayment(mismatchOrder.id);
    const reference = initiation.body.reference as string;
    const paymentId = initiation.body.payment.id as string;

    paystack.setVerification(reference, {
      status: 'success',
      amount: minorUnits(mismatchOrder.deliveryFee) + 1,
      currency: mismatchOrder.currency,
    });

    await api()
      .post('/api/v1/payments/verify')
      .set(auth(customer))
      .send({ reference })
      .expect(400);

    const payment = await api()
      .get(`/api/v1/payments/${paymentId}`)
      .set(auth(admin))
      .expect(200);
    expect(payment.body.status).toBe('PENDING');

    const unchangedOrder = await api()
      .get(`/api/v1/orders/${mismatchOrder.id}`)
      .set(auth(customer))
      .expect(200);
    expect(unchangedOrder.body.status).toBe('PENDING_PAYMENT');
  });

  it('verifies signed webhooks and processes duplicate success events idempotently', async () => {
    const webhookOrder = await createOrder();
    const initiation = await initiatePayment(webhookOrder.id);
    const reference = initiation.body.reference as string;
    const paymentId = initiation.body.payment.id as string;

    const payload = {
      event: 'charge.success',
      data: {
        reference,
        status: 'success',
        amount: minorUnits(webhookOrder.deliveryFee),
        currency: webhookOrder.currency,
        paid_at: '2026-11-04T11:00:00.000Z',
      },
    };
    const signed = signedWebhook(payload);

    await sendWebhook(payload, 'invalid-signature', 401);

    const pendingPayment = await api()
      .get(`/api/v1/payments/${paymentId}`)
      .set(auth(admin))
      .expect(200);
    expect(pendingPayment.body.status).toBe('PENDING');

    await sendWebhook(payload, signed.signature);

    const paid = await api()
      .get(`/api/v1/payments/${paymentId}`)
      .set(auth(admin))
      .expect(200);
    expect(paid.body.status).toBe('SUCCEEDED');
    expect(paid.body.paidAt).toBe('2026-11-04T11:00:00.000Z');

    const confirmedOrder = await api()
      .get(`/api/v1/orders/${webhookOrder.id}`)
      .set(auth(customer))
      .expect(200);
    expect(confirmedOrder.body.status).toBe('CONFIRMED');

    await sendWebhook(payload, signed.signature);

    const duplicate = await api()
      .get(`/api/v1/payments/${paymentId}`)
      .set(auth(admin))
      .expect(200);
    expect(duplicate.body.status).toBe('SUCCEEDED');
    expect(duplicate.body.paidAt).toBe('2026-11-04T11:00:00.000Z');

    const failedAfterSuccess = {
      event: 'charge.failed',
      data: { reference, status: 'failed' },
    };
    await sendWebhook(
      failedAfterSuccess,
      signedWebhook(failedAfterSuccess).signature,
    );

    const stillPaid = await api()
      .get(`/api/v1/payments/${paymentId}`)
      .set(auth(admin))
      .expect(200);
    expect(stillPaid.body.status).toBe('SUCCEEDED');

    const unknownReference = {
      event: 'charge.success',
      data: {
        reference: 'PAY-UNKNOWN-REFERENCE',
        amount: 100,
        currency: 'NGN',
      },
    };
    const unknownResponse = await sendWebhook(
      unknownReference,
      signedWebhook(unknownReference).signature,
    );
    expect(unknownResponse.body).toEqual({ received: true });
  });

  it('marks failed webhook payments as failed without confirming the order', async () => {
    const failedOrder = await createOrder();
    const initiation = await initiatePayment(failedOrder.id);
    const reference = initiation.body.reference as string;
    const paymentId = initiation.body.payment.id as string;

    const payload = {
      event: 'charge.failed',
      data: {
        reference,
        status: 'failed',
        amount: minorUnits(failedOrder.deliveryFee),
        currency: failedOrder.currency,
      },
    };

    await sendWebhook(payload, signedWebhook(payload).signature);

    const payment = await api()
      .get(`/api/v1/payments/${paymentId}`)
      .set(auth(admin))
      .expect(200);
    expect(payment.body.status).toBe('FAILED');

    const pendingOrder = await api()
      .get(`/api/v1/orders/${failedOrder.id}`)
      .set(auth(customer))
      .expect(200);
    expect(pendingOrder.body.status).toBe('PENDING_PAYMENT');

    await initiatePayment(failedOrder.id);
  });
});
