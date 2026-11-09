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

describe('Delivery endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const password = 'strong-password-123';
  const customerEmail = 'customer@example.com';
  const otherEmail = 'other@example.com';
  const riderOneEmail = 'rider-one@example.com';
  const riderTwoEmail = 'rider-two@example.com';
  const adminEmail = 'admin@example.com';

  let customer: Session;
  let other: Session;
  let riderOne: Session;
  let riderTwo: Session;
  let admin: Session;

  let deliveryOneId: string;
  let deliveryTwoId: string;
  let orderTwoId: string;

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

  async function login(email: string): Promise<Session> {
    const response = await api()
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    return response.body as Session;
  }

  async function createOrder(confirmed: boolean): Promise<string> {
    const response = await api()
      .post('/api/v1/orders')
      .set(auth(customer))
      .send(orderPayload)
      .expect(201);

    const orderId = response.body.id as string;

    if (confirmed) {
      await prisma.order.update({
        where: { id: orderId },
        data: { status: 'CONFIRMED' },
      });
    }

    return orderId;
  }

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
      fullName: 'Rider One',
      email: riderOneEmail,
      password,
    });
    await registerCustomer(app, {
      fullName: 'Rider Two',
      email: riderTwoEmail,
      password,
    });
    await registerCustomer(app, {
      fullName: 'Admin User',
      email: adminEmail,
      password,
    });

    await prisma.user.update({
      where: { email: riderOneEmail },
      data: { role: 'RIDER' },
    });
    await prisma.user.update({
      where: { email: riderTwoEmail },
      data: { role: 'RIDER' },
    });
    await prisma.user.update({
      where: { email: adminEmail },
      data: { role: 'ADMIN' },
    });

    riderOne = await login(riderOneEmail);
    riderTwo = await login(riderTwoEmail);
    admin = await login(adminEmail);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  it('rejects assignment for orders that are not confirmed', async () => {
    const orderId = await createOrder(false);

    await api()
      .post(`/api/v1/admin/orders/${orderId}/assign`)
      .set(auth(admin))
      .send({ riderId: riderOne.user.id })
      .expect(409);
  });

  it('restricts rider assignment to administrators', async () => {
    const orderId = await createOrder(false);

    await api()
      .post(`/api/v1/admin/orders/${orderId}/assign`)
      .set(auth(customer))
      .send({ riderId: riderOne.user.id })
      .expect(403);
  });

  it('assigns a confirmed order to an active rider', async () => {
    const orderId = await createOrder(true);

    const response = await api()
      .post(`/api/v1/admin/orders/${orderId}/assign`)
      .set(auth(admin))
      .send({ riderId: riderOne.user.id })
      .expect(200);

    expect(response.body).toMatchObject({
      orderId,
      riderId: riderOne.user.id,
      status: 'ASSIGNED',
    });
    expect(response.body.assignedAt).toEqual(expect.any(String));

    deliveryOneId = response.body.id as string;
  });

  it('hides the delivery from unrelated riders and customers', async () => {
    await api()
      .get(`/api/v1/deliveries/${deliveryOneId}`)
      .set(auth(riderTwo))
      .expect(404);

    await api()
      .get(`/api/v1/deliveries/${deliveryOneId}`)
      .set(auth(other))
      .expect(404);
  });

  it('returns the delivery to its customer, rider, and administrators', async () => {
    for (const session of [customer, riderOne, admin]) {
      const response = await api()
        .get(`/api/v1/deliveries/${deliveryOneId}`)
        .set(auth(session))
        .expect(200);

      expect(response.body.id).toBe(deliveryOneId);
    }
  });

  it('lists only the authenticated rider deliveries', async () => {
    const riderList = await api()
      .get('/api/v1/deliveries/assigned')
      .set(auth(riderOne))
      .expect(200);

    expect(riderList.body.data).toHaveLength(1);
    expect(riderList.body.data[0].id).toBe(deliveryOneId);
    expect(riderList.body.meta).toMatchObject({ total: 1, page: 1 });

    const otherRiderList = await api()
      .get('/api/v1/deliveries/assigned')
      .set(auth(riderTwo))
      .expect(200);

    expect(otherRiderList.body.data).toEqual([]);

    await api()
      .get('/api/v1/deliveries/assigned')
      .set(auth(customer))
      .expect(403);
  });

  it('prevents assigning a rider with another active delivery', async () => {
    orderTwoId = await createOrder(true);

    await api()
      .post(`/api/v1/admin/orders/${orderTwoId}/assign`)
      .set(auth(admin))
      .send({ riderId: riderOne.user.id })
      .expect(409);
  });

  it('rejects invalid rider actions and out-of-order transitions', async () => {
    await api()
      .post(`/api/v1/deliveries/${deliveryOneId}/accept`)
      .set(auth(riderTwo))
      .expect(404);

    await api()
      .post(`/api/v1/deliveries/${deliveryOneId}/pickup`)
      .set(auth(riderOne))
      .expect(409);
  });

  it('progresses a delivery through all rider milestones', async () => {
    const accepted = await api()
      .post(`/api/v1/deliveries/${deliveryOneId}/accept`)
      .set(auth(riderOne))
      .expect(200);
    expect(accepted.body.status).toBe('ACCEPTED');
    expect(accepted.body.acceptedAt).toEqual(expect.any(String));

    await api()
      .post(`/api/v1/deliveries/${deliveryOneId}/accept`)
      .set(auth(riderOne))
      .expect(409);

    const pickedUp = await api()
      .post(`/api/v1/deliveries/${deliveryOneId}/pickup`)
      .set(auth(riderOne))
      .expect(200);
    expect(pickedUp.body.status).toBe('PICKED_UP');
    expect(pickedUp.body.pickedUpAt).toEqual(expect.any(String));

    const started = await api()
      .post(`/api/v1/deliveries/${deliveryOneId}/start`)
      .set(auth(riderOne))
      .expect(200);
    expect(started.body.status).toBe('IN_TRANSIT');

    const completed = await api()
      .post(`/api/v1/deliveries/${deliveryOneId}/complete`)
      .set(auth(riderOne))
      .expect(200);
    expect(completed.body.status).toBe('DELIVERED');
    expect(completed.body.deliveredAt).toEqual(expect.any(String));

    await api()
      .post(`/api/v1/deliveries/${deliveryOneId}/complete`)
      .set(auth(riderOne))
      .expect(409);
  });

  it('records delivery status history and closes the assignment', async () => {
    const history = await prisma.deliveryStatusHistory.findMany({
      where: { deliveryId: deliveryOneId },
      orderBy: { createdAt: 'asc' },
    });

    expect(history.map((entry) => entry.newStatus)).toEqual([
      'ASSIGNED',
      'ACCEPTED',
      'PICKED_UP',
      'IN_TRANSIT',
      'DELIVERED',
    ]);

    const assignment = await prisma.deliveryAssignment.findFirst({
      where: { deliveryId: deliveryOneId },
      orderBy: { assignedAt: 'desc' },
    });
    expect(assignment?.endedAt).not.toBeNull();
  });

  it('supports rejection, reassignment, and failure', async () => {
    const assigned = await api()
      .post(`/api/v1/admin/orders/${orderTwoId}/assign`)
      .set(auth(admin))
      .send({ riderId: riderOne.user.id })
      .expect(200);
    deliveryTwoId = assigned.body.id as string;

    const rejected = await api()
      .post(`/api/v1/deliveries/${deliveryTwoId}/reject`)
      .set(auth(riderOne))
      .expect(200);
    expect(rejected.body).toMatchObject({
      status: 'PENDING_ASSIGNMENT',
      riderId: null,
    });

    const reassigned = await api()
      .post(`/api/v1/admin/orders/${orderTwoId}/assign`)
      .set(auth(admin))
      .send({ riderId: riderTwo.user.id })
      .expect(200);
    expect(reassigned.body).toMatchObject({
      status: 'ASSIGNED',
      riderId: riderTwo.user.id,
    });

    await api()
      .post(`/api/v1/deliveries/${deliveryTwoId}/accept`)
      .set(auth(riderTwo))
      .expect(200);

    const reassignedAgain = await api()
      .post(`/api/v1/admin/deliveries/${deliveryTwoId}/reassign`)
      .set(auth(admin))
      .send({ riderId: riderOne.user.id })
      .expect(200);
    expect(reassignedAgain.body).toMatchObject({
      status: 'ASSIGNED',
      riderId: riderOne.user.id,
      acceptedAt: null,
    });

    await api()
      .post(`/api/v1/deliveries/${deliveryTwoId}/fail`)
      .set(auth(riderOne))
      .send({})
      .expect(400);

    const failed = await api()
      .post(`/api/v1/deliveries/${deliveryTwoId}/fail`)
      .set(auth(riderOne))
      .send({ reason: 'Customer unavailable at the delivery address' })
      .expect(200);

    expect(failed.body).toMatchObject({
      status: 'FAILED',
      failureReason: 'Customer unavailable at the delivery address',
    });

    await api()
      .post(`/api/v1/deliveries/${deliveryTwoId}/accept`)
      .set(auth(riderOne))
      .expect(409);
  });

  it('lists rider accounts for administrators only', async () => {
    const response = await api()
      .get('/api/v1/admin/riders')
      .set(auth(admin))
      .expect(200);

    expect(
      response.body.data.map((rider: { email: string }) => rider.email),
    ).toEqual(expect.arrayContaining([riderOneEmail, riderTwoEmail]));

    await api().get('/api/v1/admin/riders').set(auth(customer)).expect(403);
  });
});
