import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
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

describe('Orders endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const password = 'strong-password-123';
  const customerEmail = 'customer@example.com';
  const otherEmail = 'other@example.com';
  const adminEmail = 'admin@example.com';

  let customer: Session;
  let other: Session;
  let admin: Session;

  let orderId: string;

  const api = () => request(app.getHttpServer());
  const auth = (session: Session) => ({
    Authorization: `Bearer ${session.accessToken}`,
  });
  const orderPayload = {
    pickupAddress: '12 Marina Road, Lagos',
    pickupLatitude: 6.4531,
    pickupLongitude: 3.3881,
    deliveryAddress: '45 Adeola Odeku Street, Lagos',
    deliveryLatitude: 6.4281,
    deliveryLongitude: 3.4219,
    packageDescription: 'Small sealed carton',
    deliveryInstructions: 'Call on arrival',
  };

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
    await resetDatabase(prisma);

    customer = await registerCustomer(app, {
      fullName: 'Customer One',
      email: customerEmail,
      password,
    });
    other = await registerCustomer(app, {
      fullName: 'Customer Two',
      email: otherEmail,
      password,
    });
    await registerCustomer(app, {
      fullName: 'Admin User',
      email: adminEmail,
      password,
    });
    await prisma.user.update({
      where: { email: adminEmail },
      data: { role: 'ADMIN' },
    });

    const adminLogin = await api()
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password })
      .expect(200);
    admin = adminLogin.body as Session;
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  it('creates a pending-payment order with server-side pricing', async () => {
    const response = await api()
      .post('/api/v1/orders')
      .set(auth(customer))
      .send(orderPayload)
      .expect(201);

    expect(response.body).toMatchObject({
      customerId: customer.user.id,
      pickupAddress: orderPayload.pickupAddress,
      deliveryAddress: orderPayload.deliveryAddress,
      packageDescription: orderPayload.packageDescription,
      currency: 'NGN',
      status: 'PENDING_PAYMENT',
    });
    expect(response.body.orderNumber).toMatch(/^ORD-\d{8}-[A-Z0-9]{6}$/);
    expect(Number(response.body.deliveryFee)).toBe(1500);

    orderId = response.body.id;
  });

  it('requires authentication to create an order', async () => {
    await api().post('/api/v1/orders').send(orderPayload).expect(401);
  });

  it('rejects client-controlled pricing', async () => {
    await api()
      .post('/api/v1/orders')
      .set(auth(customer))
      .send({ ...orderPayload, deliveryFee: 1 })
      .expect(400);
  });

  it('requires latitude and longitude pairs', async () => {
    await api()
      .post('/api/v1/orders')
      .set(auth(customer))
      .send({ ...orderPayload, pickupLongitude: undefined })
      .expect(400);
  });

  it('rejects an invalid order id', async () => {
    await api()
      .get('/api/v1/orders/not-a-uuid')
      .set(auth(customer))
      .expect(400);
  });

  it('returns the order to its owner with pricing', async () => {
    const response = await api()
      .get(`/api/v1/orders/${orderId}`)
      .set(auth(customer))
      .expect(200);

    expect(response.body).toMatchObject({
      id: orderId,
      customerId: customer.user.id,
      currency: 'NGN',
    });
    expect(Number(response.body.deliveryFee)).toBe(1500);
  });

  it('hides another customer order and excludes it from their list', async () => {
    await api().get(`/api/v1/orders/${orderId}`).set(auth(other)).expect(404);

    const listResponse = await api()
      .get('/api/v1/orders')
      .set(auth(other))
      .expect(200);

    expect(listResponse.body.data).toEqual([]);
    expect(listResponse.body.meta).toMatchObject({ total: 0, page: 1 });
  });

  it('lists the customer own orders with pagination metadata', async () => {
    const response = await api()
      .get('/api/v1/orders?page=1&limit=10')
      .set(auth(customer))
      .expect(200);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].id).toBe(orderId);
    expect(response.body.meta).toMatchObject({
      page: 1,
      limit: 10,
      total: 1,
      totalPages: 1,
    });
  });

  it('allows admins to list every order', async () => {
    const response = await api()
      .get('/api/v1/orders')
      .set(auth(admin))
      .expect(200);

    expect(
      response.body.data.map((order: { id: string }) => order.id),
    ).toContain(orderId);
  });

  it('hides another customer order from cancellation', async () => {
    await api()
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set(auth(other))
      .expect(404);
  });

  it('returns order history with no delivery yet', async () => {
    const response = await api()
      .get(`/api/v1/orders/${orderId}/history`)
      .set(auth(customer))
      .expect(200);

    expect(response.body.order).toMatchObject({
      id: orderId,
      status: 'PENDING_PAYMENT',
    });
    expect(response.body.delivery).toBeNull();
    expect(response.body.deliveryHistory).toEqual([]);
  });

  it('cancels a pending-payment order once', async () => {
    const createResponse = await api()
      .post('/api/v1/orders')
      .set(auth(customer))
      .send(orderPayload)
      .expect(201);
    const cancellableOrderId = createResponse.body.id as string;

    const cancelResponse = await api()
      .post(`/api/v1/orders/${cancellableOrderId}/cancel`)
      .set(auth(customer))
      .expect(200);
    expect(cancelResponse.body.status).toBe('CANCELLED');

    await api()
      .post(`/api/v1/orders/${cancellableOrderId}/cancel`)
      .set(auth(customer))
      .expect(409);
  });

  it('allows an admin to cancel a pending order', async () => {
    const response = await api()
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set(auth(admin))
      .expect(200);

    expect(response.body.status).toBe('CANCELLED');
  });

  it('restricts riders to assigned orders', async () => {
    await prisma.user.update({
      where: { id: other.user.id },
      data: { role: 'RIDER' },
    });

    await api()
      .post('/api/v1/orders')
      .set(auth(other))
      .send(orderPayload)
      .expect(403);

    await api().get(`/api/v1/orders/${orderId}`).set(auth(other)).expect(404);

    const listResponse = await api()
      .get('/api/v1/orders')
      .set(auth(other))
      .expect(200);

    expect(listResponse.body.data).toEqual([]);
  });
});
