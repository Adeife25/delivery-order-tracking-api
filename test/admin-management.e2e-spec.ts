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

describe('Admin management (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const password = 'strong-password-123';
  const customerEmail = 'admin-management-customer@example.com';
  const managedCustomerEmail = 'admin-management-managed@example.com';
  const riderActiveEmail = 'admin-management-rider-active@example.com';
  const riderBusyEmail = 'admin-management-rider-busy@example.com';
  const adminEmail = 'admin-management-admin@example.com';

  let customer: Session;
  let managedCustomer: Session;
  let riderActive: Session;
  let riderBusy: Session;
  let admin: Session;
  let orderOneId: string;
  let orderTwoId: string;
  let orderFourId: string;

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

  async function createOrder(
    orderNumber: string,
    customerId: string,
    status: 'CONFIRMED' | 'PENDING_PAYMENT' | 'CANCELLED',
  ) {
    return prisma.order.create({
      data: {
        orderNumber,
        customerId,
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
      fullName: 'Admin Management Customer',
      email: customerEmail,
      password,
    });
    managedCustomer = await registerCustomer(app, {
      fullName: 'Managed Customer',
      email: managedCustomerEmail,
      password,
    });
    await registerCustomer(app, {
      fullName: 'Active Rider',
      email: riderActiveEmail,
      password,
    });
    await registerCustomer(app, {
      fullName: 'Busy Rider',
      email: riderBusyEmail,
      password,
    });
    await registerCustomer(app, {
      fullName: 'Admin Manager',
      email: adminEmail,
      password,
    });

    const riderActiveUser = await prisma.user.update({
      where: { email: riderActiveEmail },
      data: { role: 'RIDER' },
    });
    const riderBusyUser = await prisma.user.update({
      where: { email: riderBusyEmail },
      data: { role: 'RIDER' },
    });
    await prisma.user.update({
      where: { email: adminEmail },
      data: { role: 'ADMIN' },
    });

    riderActive = await login(riderActiveEmail);
    riderBusy = await login(riderBusyEmail);
    admin = await login(adminEmail);

    const orderOne = await createOrder(
      'ORD-MGMT-0001',
      customer.user.id,
      'CONFIRMED',
    );
    const orderTwo = await createOrder(
      'ORD-MGMT-0002',
      managedCustomer.user.id,
      'PENDING_PAYMENT',
    );
    const orderThree = await createOrder(
      'ORD-MGMT-0003',
      customer.user.id,
      'CANCELLED',
    );
    const orderFour = await createOrder(
      'ORD-MGMT-0004',
      customer.user.id,
      'CONFIRMED',
    );
    orderOneId = orderOne.id;
    orderTwoId = orderTwo.id;
    orderFourId = orderFour.id;

    await prisma.delivery.create({
      data: {
        orderId: orderThree.id,
        riderId: riderActiveUser.id,
        status: 'DELIVERED',
        assignedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        acceptedAt: new Date(Date.now() - 2.9 * 60 * 60 * 1000),
        pickedUpAt: new Date(Date.now() - 2.5 * 60 * 60 * 1000),
        deliveredAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });
    await prisma.delivery.create({
      data: {
        orderId: orderFour.id,
        riderId: riderBusyUser.id,
        status: 'IN_TRANSIT',
        assignedAt: new Date(Date.now() - 60 * 60 * 1000),
        acceptedAt: new Date(Date.now() - 55 * 60 * 1000),
        pickedUpAt: new Date(Date.now() - 50 * 60 * 1000),
      },
    });

    await prisma.payment.create({
      data: {
        orderId: orderOne.id,
        provider: 'paystack',
        providerReference: 'MGMT-PAY-SUCCESS',
        amount: '1500.00',
        currency: 'NGN',
        status: 'SUCCEEDED',
        paidAt: new Date(Date.now() - 30 * 60 * 1000),
      },
    });
    await prisma.payment.create({
      data: {
        orderId: orderTwo.id,
        provider: 'paystack',
        providerReference: 'MGMT-PAY-FAILED',
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

  it('lists and filters all orders for administrators only', async () => {
    const all = await api()
      .get('/api/v1/admin/orders')
      .set(auth(admin))
      .expect(200);
    expect(all.body.meta).toMatchObject({
      page: 1,
      limit: 20,
      total: 4,
      totalPages: 1,
    });

    const confirmed = await api()
      .get('/api/v1/admin/orders')
      .query({ status: 'CONFIRMED' })
      .set(auth(admin))
      .expect(200);
    expect(
      confirmed.body.data.map((order: { id: string }) => order.id).sort(),
    ).toEqual([orderFourId, orderOneId].sort());

    const byCustomer = await api()
      .get('/api/v1/admin/orders')
      .query({ customerId: managedCustomer.user.id })
      .set(auth(admin))
      .expect(200);
    expect(byCustomer.body.data).toHaveLength(1);
    expect(byCustomer.body.data[0].id).toBe(orderTwoId);

    const byNumber = await api()
      .get('/api/v1/admin/orders')
      .query({ orderNumber: 'mgmt-0001' })
      .set(auth(admin))
      .expect(200);
    expect(byNumber.body.data).toHaveLength(1);
    expect(byNumber.body.data[0].id).toBe(orderOneId);

    const byRider = await api()
      .get('/api/v1/admin/orders')
      .query({ riderId: riderBusy.user.id })
      .set(auth(admin))
      .expect(200);
    expect(byRider.body.data).toHaveLength(1);
    expect(byRider.body.data[0].id).toBe(orderFourId);

    await api().get('/api/v1/admin/orders').expect(401);
    await api().get('/api/v1/admin/orders').set(auth(customer)).expect(403);
  });

  it('lists and filters payment records for administrators only', async () => {
    const all = await api()
      .get('/api/v1/admin/payments')
      .set(auth(admin))
      .expect(200);
    expect(all.body.meta.total).toBe(2);

    const succeeded = await api()
      .get('/api/v1/admin/payments')
      .query({ status: 'SUCCEEDED' })
      .set(auth(admin))
      .expect(200);
    expect(succeeded.body.data).toHaveLength(1);
    expect(succeeded.body.data[0].providerReference).toBe('MGMT-PAY-SUCCESS');

    const byOrder = await api()
      .get('/api/v1/admin/payments')
      .query({ orderId: orderTwoId })
      .set(auth(admin))
      .expect(200);
    expect(byOrder.body.data).toHaveLength(1);
    expect(byOrder.body.data[0].status).toBe('FAILED');

    const byCustomer = await api()
      .get('/api/v1/admin/payments')
      .query({ customerId: managedCustomer.user.id })
      .set(auth(admin))
      .expect(200);
    expect(byCustomer.body.data).toHaveLength(1);

    const byReference = await api()
      .get('/api/v1/admin/payments')
      .query({ providerReference: 'success' })
      .set(auth(admin))
      .expect(200);
    expect(byReference.body.data).toHaveLength(1);

    await api().get('/api/v1/admin/payments').set(auth(customer)).expect(403);
  });

  it('lists customer accounts for administrators only', async () => {
    const response = await api()
      .get('/api/v1/admin/customers')
      .set(auth(admin))
      .expect(200);

    expect(response.body.meta.total).toBe(2);
    expect(
      response.body.data.map((user: { email: string }) => user.email).sort(),
    ).toEqual([customerEmail, managedCustomerEmail].sort());

    await api().get('/api/v1/admin/customers').set(auth(customer)).expect(403);
  });

  it('activates and deactivates customer and rider accounts safely', async () => {
    const deactivated = await api()
      .patch(`/api/v1/admin/users/${managedCustomer.user.id}/status`)
      .set(auth(admin))
      .send({ isActive: false })
      .expect(200);
    expect(deactivated.body).toMatchObject({
      id: managedCustomer.user.id,
      isActive: false,
    });

    await api().get('/api/v1/users/me').set(auth(managedCustomer)).expect(401);

    await api()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: managedCustomer.refreshToken })
      .expect(401);

    const inactiveCustomers = await api()
      .get('/api/v1/admin/customers')
      .query({ isActive: false })
      .set(auth(admin))
      .expect(200);
    expect(inactiveCustomers.body.data).toHaveLength(1);

    const reactivated = await api()
      .patch(`/api/v1/admin/users/${managedCustomer.user.id}/status`)
      .set(auth(admin))
      .send({ isActive: true })
      .expect(200);
    expect(reactivated.body.isActive).toBe(true);

    await api()
      .patch(`/api/v1/admin/users/${riderBusy.user.id}/status`)
      .set(auth(admin))
      .send({ isActive: false })
      .expect(409);

    const deactivatedRider = await api()
      .patch(`/api/v1/admin/users/${riderActive.user.id}/status`)
      .set(auth(admin))
      .send({ isActive: false })
      .expect(200);
    expect(deactivatedRider.body.isActive).toBe(false);

    await api()
      .patch(`/api/v1/admin/users/${riderActive.user.id}/status`)
      .set(auth(admin))
      .send({ isActive: true })
      .expect(200);
  });

  it('rejects invalid account management targets and callers', async () => {
    await api()
      .patch(`/api/v1/admin/users/${admin.user.id}/status`)
      .set(auth(admin))
      .send({ isActive: false })
      .expect(400);

    await api()
      .patch('/api/v1/admin/users/11111111-1111-4111-8111-111111111111/status')
      .set(auth(admin))
      .send({ isActive: false })
      .expect(404);

    await api()
      .patch(`/api/v1/admin/users/${managedCustomer.user.id}/status`)
      .set(auth(customer))
      .send({ isActive: false })
      .expect(403);

    await api()
      .patch(`/api/v1/admin/users/${managedCustomer.user.id}/status`)
      .set(auth(admin))
      .send({ isActive: 'yes' })
      .expect(400);
  });
});
