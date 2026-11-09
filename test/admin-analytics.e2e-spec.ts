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

describe('Admin analytics and rider performance (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const password = 'strong-password-123';
  const customerEmail = 'admin-customer@example.com';
  const riderOneEmail = 'admin-rider-one@example.com';
  const riderTwoEmail = 'admin-rider-two@example.com';
  const adminEmail = 'admin-dashboard@example.com';

  let customer: Session;
  let riderOne: Session;
  let riderTwo: Session;
  let admin: Session;
  let riderOneDeliveredId: string;

  const api = () => request(app.getHttpServer());
  const auth = (session: Session) => ({
    Authorization: `Bearer ${session.accessToken}`,
  });

  async function login(email: string): Promise<Session> {
    const response = await api()
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    return response.body as Session;
  }

  function addMinutes(date: Date, minutes: number): Date {
    return new Date(date.getTime() + minutes * 60 * 1000);
  }

  async function createOrder(
    orderNumber: string,
    status: 'CONFIRMED' | 'PENDING_PAYMENT' | 'CANCELLED',
  ) {
    return prisma.order.create({
      data: {
        orderNumber,
        customerId: customer.user.id,
        pickupAddress: '12 Marina Road, Lagos',
        deliveryAddress: '45 Adeola Odeku Street, Lagos',
        packageDescription: 'Small sealed carton',
        deliveryFee: '1500.00',
        currency: 'NGN',
        status,
      },
    });
  }

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
    await resetDatabase(prisma);

    customer = await registerCustomer(app, {
      fullName: 'Admin Analytics Customer',
      email: customerEmail,
      password,
    });
    await registerCustomer(app, {
      fullName: 'Admin Rider One',
      email: riderOneEmail,
      password,
    });
    riderTwo = await registerCustomer(app, {
      fullName: 'Admin Rider Two',
      email: riderTwoEmail,
      password,
    });
    await registerCustomer(app, {
      fullName: 'Admin Dashboard User',
      email: adminEmail,
      password,
    });

    await prisma.user.update({
      where: { email: riderOneEmail },
      data: { role: 'RIDER' },
    });
    await prisma.user.update({
      where: { email: riderTwoEmail },
      data: { role: 'RIDER', isActive: false },
    });
    await prisma.user.update({
      where: { email: adminEmail },
      data: { role: 'ADMIN' },
    });

    riderOne = await login(riderOneEmail);
    admin = await login(adminEmail);

    const base = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const at = (minutes: number) => addMinutes(base, minutes);

    const orderOne = await createOrder('ORD-ADMIN-0001', 'CONFIRMED');
    const orderTwo = await createOrder('ORD-ADMIN-0002', 'CONFIRMED');
    const orderThree = await createOrder('ORD-ADMIN-0003', 'CONFIRMED');
    const orderFour = await createOrder('ORD-ADMIN-0004', 'CONFIRMED');
    await createOrder('ORD-ADMIN-0005', 'PENDING_PAYMENT');
    await createOrder('ORD-ADMIN-0006', 'CANCELLED');

    const deliveredOne = await prisma.delivery.create({
      data: {
        orderId: orderOne.id,
        riderId: riderOne.user.id,
        status: 'DELIVERED',
        assignedAt: at(0),
        acceptedAt: at(2),
        pickedUpAt: at(5),
        deliveredAt: at(25),
      },
    });
    riderOneDeliveredId = deliveredOne.id;

    const failedOne = await prisma.delivery.create({
      data: {
        orderId: orderTwo.id,
        riderId: riderOne.user.id,
        status: 'FAILED',
        assignedAt: at(60),
        acceptedAt: at(61),
        pickedUpAt: at(63),
        failureReason: 'Customer unavailable',
      },
    });

    const activeOne = await prisma.delivery.create({
      data: {
        orderId: orderThree.id,
        riderId: riderOne.user.id,
        status: 'IN_TRANSIT',
        assignedAt: at(120),
        acceptedAt: at(122),
        pickedUpAt: at(125),
      },
    });

    const deliveredTwo = await prisma.delivery.create({
      data: {
        orderId: orderFour.id,
        riderId: riderTwo.user.id,
        status: 'DELIVERED',
        assignedAt: at(240),
        acceptedAt: at(244),
        pickedUpAt: at(250),
        deliveredAt: at(280),
      },
    });

    await prisma.deliveryAssignment.createMany({
      data: [
        {
          deliveryId: deliveredOne.id,
          riderId: riderOne.user.id,
          assignedById: admin.user.id,
          assignedAt: at(0),
          endedAt: at(25),
        },
        {
          deliveryId: failedOne.id,
          riderId: riderOne.user.id,
          assignedById: admin.user.id,
          assignedAt: at(60),
          endedAt: at(65),
        },
        {
          deliveryId: activeOne.id,
          riderId: riderOne.user.id,
          assignedById: admin.user.id,
          assignedAt: at(120),
        },
        {
          deliveryId: deliveredTwo.id,
          riderId: riderTwo.user.id,
          assignedById: admin.user.id,
          assignedAt: at(240),
          endedAt: at(280),
        },
      ],
    });

    await prisma.payment.create({
      data: {
        orderId: orderTwo.id,
        provider: 'paystack',
        providerReference: 'ADMIN-PAY-SUCCESS',
        amount: '1500.00',
        currency: 'NGN',
        status: 'SUCCEEDED',
        paidAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    await prisma.payment.create({
      data: {
        orderId: orderThree.id,
        provider: 'paystack',
        providerReference: 'ADMIN-PAY-FAILED',
        amount: '1500.00',
        currency: 'NGN',
        status: 'FAILED',
      },
    });
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  it('returns platform dashboard totals to administrators only', async () => {
    const response = await api()
      .get('/api/v1/admin/dashboard')
      .set(auth(admin))
      .expect(200);

    expect(response.body).toMatchObject({
      orders: {
        total: 6,
        pendingPayment: 1,
        confirmed: 4,
        cancelled: 1,
        createdLast7Days: 6,
      },
      deliveries: {
        total: 4,
        pendingAssignment: 0,
        assigned: 0,
        accepted: 0,
        pickedUp: 0,
        inTransit: 1,
        delivered: 2,
        failed: 1,
        cancelled: 0,
        active: 1,
        deliveredLast7Days: 2,
        failedLast7Days: 1,
      },
      payments: {
        total: 2,
        pending: 0,
        succeeded: 1,
        failed: 1,
        refunded: 0,
        revenueByCurrency: [{ currency: 'NGN', amount: '1500.00' }],
        revenueLast7DaysByCurrency: [{ currency: 'NGN', amount: '1500.00' }],
      },
      riders: {
        total: 2,
        active: 1,
        inactive: 1,
        withActiveDeliveries: 1,
      },
    });
    expect(response.body.generatedAt).toEqual(expect.any(String));

    await api().get('/api/v1/admin/dashboard').expect(401);

    await api().get('/api/v1/admin/dashboard').set(auth(customer)).expect(403);
  });

  it('lists rider performance with sorting, filtering, and pagination', async () => {
    const response = await api()
      .get('/api/v1/admin/riders/performance')
      .query({ sort: 'totalAssignments', order: 'desc' })
      .set(auth(admin))
      .expect(200);

    expect(response.body.meta).toMatchObject({
      page: 1,
      limit: 20,
      total: 2,
      totalPages: 1,
    });
    expect(response.body.data).toHaveLength(2);
    expect(response.body.data[0]).toMatchObject({
      rider: { id: riderOne.user.id, isActive: true },
      metrics: {
        totalAssignments: 3,
        totalDeliveries: 3,
        activeDeliveries: 1,
        completed: 1,
        failed: 1,
        completionRate: 50,
        averageAcceptanceSeconds: 100,
        averageDeliveryMinutes: 20,
      },
    });
    expect(response.body.data[0].metrics.lastDeliveredAt).toEqual(
      expect.any(String),
    );
    expect(response.body.data[1]).toMatchObject({
      rider: { id: riderTwo.user.id, isActive: false },
      metrics: {
        totalAssignments: 1,
        totalDeliveries: 1,
        activeDeliveries: 0,
        completed: 1,
        failed: 0,
        completionRate: 100,
        averageAcceptanceSeconds: 240,
        averageDeliveryMinutes: 30,
      },
    });

    const activeOnly = await api()
      .get('/api/v1/admin/riders/performance')
      .query({ isActive: true })
      .set(auth(admin))
      .expect(200);
    expect(
      activeOnly.body.data.map(
        (entry: { rider: { id: string } }) => entry.rider.id,
      ),
    ).toEqual([riderOne.user.id]);

    const secondPage = await api()
      .get('/api/v1/admin/riders/performance')
      .query({ sort: 'totalAssignments', order: 'desc', page: 2, limit: 1 })
      .set(auth(admin))
      .expect(200);
    expect(secondPage.body.data).toHaveLength(1);
    expect(secondPage.body.data[0].rider.id).toBe(riderTwo.user.id);
    expect(secondPage.body.meta).toMatchObject({
      page: 2,
      limit: 1,
      total: 2,
      totalPages: 2,
    });

    await api()
      .get('/api/v1/admin/riders/performance')
      .query({ sort: 'unknown' })
      .set(auth(admin))
      .expect(400);
  });

  it('returns a rider performance profile with recent deliveries', async () => {
    const response = await api()
      .get(`/api/v1/admin/riders/${riderOne.user.id}/performance`)
      .set(auth(admin))
      .expect(200);

    expect(response.body).toMatchObject({
      rider: { id: riderOne.user.id, email: riderOneEmail },
      metrics: {
        totalAssignments: 3,
        totalDeliveries: 3,
        activeDeliveries: 1,
        completed: 1,
        failed: 1,
        completionRate: 50,
        averageAcceptanceSeconds: 100,
        averageDeliveryMinutes: 20,
      },
    });
    expect(response.body.recentDeliveries).toHaveLength(3);
    expect(
      response.body.recentDeliveries.map(
        (delivery: { id: string }) => delivery.id,
      ),
    ).toContain(riderOneDeliveredId);

    await api()
      .get(
        '/api/v1/admin/riders/11111111-1111-4111-8111-111111111111/performance',
      )
      .set(auth(admin))
      .expect(404);

    await api()
      .get(`/api/v1/admin/riders/${riderOne.user.id}/performance`)
      .set(auth(customer))
      .expect(403);
  });
});
