import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import request from 'supertest';
import { Socket, io } from 'socket.io-client';
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

interface NotificationResponse {
  type: string;
  status: string;
}

interface StatusEvent {
  deliveryId: string;
  status: string;
}

interface AssignedEvent {
  deliveryId: string;
  riderId: string;
  status: string;
}

interface LocationEvent {
  deliveryId: string;
  status: string;
  location: {
    latitude: string | number;
    longitude: string | number;
  };
}

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

describe('Tracking and notifications (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let socketUrl: string;

  const password = 'strong-password-123';
  const customerEmail = 'tracking-customer@example.com';
  const otherEmail = 'tracking-other@example.com';
  const riderOneEmail = 'tracking-rider-one@example.com';
  const riderTwoEmail = 'tracking-rider-two@example.com';
  const adminEmail = 'tracking-admin@example.com';

  let customer: Session;
  let other: Session;
  let riderOne: Session;
  let riderTwo: Session;
  let admin: Session;

  let customerSocket: Socket;
  let riderTwoSocket: Socket;
  let otherSocket: Socket;

  let orderId: string;
  let deliveryId: string;

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

  function connectAs(token?: string): Promise<Socket> {
    const socket = io(`${socketUrl}/tracking`, {
      auth: token ? { token } : {},
      transports: ['websocket'],
      reconnection: false,
      timeout: 3000,
    });

    return new Promise((resolve, reject) => {
      const onConnect = () => {
        cleanup();
        resolve(socket);
      };
      const onError = (error: Error) => {
        cleanup();
        socket.close();
        reject(error);
      };
      const cleanup = () => {
        socket.off('connect', onConnect);
        socket.off('connect_error', onError);
      };

      socket.on('connect', onConnect);
      socket.on('connect_error', onError);
    });
  }

  function waitForEvent<T>(
    socket: Socket,
    event: string,
    timeout = 5000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off(event, handler);
        reject(new Error(`Timed out waiting for ${event}`));
      }, timeout);
      const handler = (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      };

      socket.once(event, handler);
    });
  }

  function joinDelivery(
    socket: Socket,
    id: string,
  ): Promise<{ joined: true; deliveryId: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out joining delivery')),
        5000,
      );

      socket.emit(
        'delivery:join',
        { deliveryId: id },
        (response: { joined: true; deliveryId: string }) => {
          clearTimeout(timer);
          resolve(response);
        },
      );
    });
  }

  async function waitForNotification(
    session: Session,
    type: string,
    timeout = 5000,
  ): Promise<NotificationResponse> {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const response = await api()
        .get('/api/v1/notifications')
        .query({ type, limit: 100 })
        .set(auth(session))
        .expect(200);

      const notification = (response.body.data as NotificationResponse[]).find(
        (entry) => entry.type === type && entry.status === 'SENT',
      );

      if (notification) {
        return notification;
      }

      await sleep(50);
    }

    throw new Error(`Timed out waiting for ${type} notification`);
  }

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
    await resetDatabase(prisma);

    await app.listen(0);
    socketUrl = `http://127.0.0.1:${new URL(await app.getUrl()).port}`;

    customer = await registerCustomer(app, {
      fullName: 'Tracking Customer',
      email: customerEmail,
      password,
    });
    other = await registerCustomer(app, {
      fullName: 'Other Customer',
      email: otherEmail,
      password,
    });
    await registerCustomer(app, {
      fullName: 'Tracking Rider One',
      email: riderOneEmail,
      password,
    });
    await registerCustomer(app, {
      fullName: 'Tracking Rider Two',
      email: riderTwoEmail,
      password,
    });
    await registerCustomer(app, {
      fullName: 'Tracking Admin',
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
    customerSocket?.disconnect();
    riderTwoSocket?.disconnect();
    otherSocket?.disconnect();
    await resetDatabase(prisma);
    await app.close();
  });

  it('creates an order and records a sent order notification', async () => {
    const response = await api()
      .post('/api/v1/orders')
      .set(auth(customer))
      .send(orderPayload)
      .expect(201);

    orderId = response.body.id as string;

    const notification = await waitForNotification(customer, 'ORDER_CREATED');
    expect(notification.status).toBe('SENT');
  });

  it('authenticates socket clients and rejects missing tokens', async () => {
    await expect(connectAs()).rejects.toThrow('Unauthorized');

    customerSocket = await connectAs(customer.accessToken);
    riderTwoSocket = await connectAs(riderTwo.accessToken);
    otherSocket = await connectAs(other.accessToken);
  });

  it('assigns a rider and notifies the rider and customer', async () => {
    await prisma.order.update({
      where: { id: orderId },
      data: { status: 'CONFIRMED' },
    });

    const response = await api()
      .post(`/api/v1/admin/orders/${orderId}/assign`)
      .set(auth(admin))
      .send({ riderId: riderOne.user.id })
      .expect(200);

    deliveryId = response.body.id as string;

    await waitForNotification(riderOne, 'DELIVERY_ASSIGNED');
    await waitForNotification(customer, 'RIDER_ASSIGNED');

    await expect(
      joinDelivery(customerSocket, deliveryId),
    ).resolves.toMatchObject({ joined: true, deliveryId });
  });

  it('rejects socket joins for unrelated users', async () => {
    const exception = waitForEvent<{ message: string }>(
      otherSocket,
      'exception',
    );

    otherSocket.emit('delivery:join', { deliveryId });

    await expect(exception).resolves.toMatchObject({
      status: 'error',
      message: 'Delivery not found',
    });

    const riderException = waitForEvent<{ message: string }>(
      riderTwoSocket,
      'exception',
    );

    riderTwoSocket.emit('delivery:join', { deliveryId });

    await expect(riderException).resolves.toMatchObject({
      status: 'error',
      message: 'Delivery not found',
    });
  });

  it('emits an assigned event when a delivery is reassigned', async () => {
    const assigned = waitForEvent<AssignedEvent>(
      customerSocket,
      'delivery:assigned',
    );

    await api()
      .post(`/api/v1/admin/deliveries/${deliveryId}/reassign`)
      .set(auth(admin))
      .send({ riderId: riderTwo.user.id })
      .expect(200);

    await expect(assigned).resolves.toMatchObject({
      deliveryId,
      riderId: riderTwo.user.id,
      status: 'ASSIGNED',
    });
    await expect(
      joinDelivery(riderTwoSocket, deliveryId),
    ).resolves.toMatchObject({ joined: true, deliveryId });
    await waitForNotification(riderTwo, 'DELIVERY_ASSIGNED');
  });

  it('emits status and location events while a delivery is active', async () => {
    const accepted = waitForEvent<StatusEvent>(
      customerSocket,
      'delivery:status_updated',
    );

    await api()
      .post(`/api/v1/deliveries/${deliveryId}/accept`)
      .set(auth(riderTwo))
      .expect(200);

    await expect(accepted).resolves.toMatchObject({
      deliveryId,
      status: 'ACCEPTED',
    });
    await waitForNotification(customer, 'DELIVERY_ACCEPTED');

    const locationUpdated = waitForEvent<LocationEvent>(
      customerSocket,
      'delivery:location_updated',
    );

    const location = await api()
      .post(`/api/v1/deliveries/${deliveryId}/location`)
      .set(auth(riderTwo))
      .send({ latitude: 6.5244, longitude: 3.3792 })
      .expect(201);

    expect(location.body).toMatchObject({
      deliveryId,
      latitude: '6.5244',
      longitude: '3.3792',
    });

    const event = await locationUpdated;
    expect(event).toMatchObject({ deliveryId, status: 'ACCEPTED' });
    expect(Number(event.location.latitude)).toBeCloseTo(6.5244, 6);
    expect(Number(event.location.longitude)).toBeCloseTo(3.3792, 6);

    await api()
      .post(`/api/v1/deliveries/${deliveryId}/pickup`)
      .set(auth(riderTwo))
      .expect(200);
    await api()
      .post(`/api/v1/deliveries/${deliveryId}/start`)
      .set(auth(riderTwo))
      .expect(200);
  });

  it('emits a completed event and stops location updates', async () => {
    const completed = waitForEvent<StatusEvent>(
      customerSocket,
      'delivery:completed',
    );

    await api()
      .post(`/api/v1/deliveries/${deliveryId}/complete`)
      .set(auth(riderTwo))
      .expect(200);

    await expect(completed).resolves.toMatchObject({
      deliveryId,
      status: 'DELIVERED',
    });
    await waitForNotification(customer, 'DELIVERY_COMPLETED');

    await api()
      .post(`/api/v1/deliveries/${deliveryId}/location`)
      .set(auth(riderTwo))
      .send({ latitude: 6.5, longitude: 3.4 })
      .expect(409);
  });

  it('returns tracking data only to authorised users', async () => {
    const response = await api()
      .get(`/api/v1/deliveries/${deliveryId}/tracking`)
      .set(auth(customer))
      .expect(200);

    expect(response.body.delivery.id).toBe(deliveryId);
    expect(response.body.latestLocation).toMatchObject({
      deliveryId,
      latitude: '6.5244',
      longitude: '3.3792',
    });
    expect(response.body.locations).toHaveLength(1);
    const statusHistory = response.body.statusHistory.map(
      (entry: { newStatus: string }) => entry.newStatus,
    );
    expect(statusHistory).toHaveLength(5);
    expect(statusHistory).toEqual(
      expect.arrayContaining([
        'ASSIGNED',
        'ACCEPTED',
        'PICKED_UP',
        'IN_TRANSIT',
        'DELIVERED',
      ]),
    );

    await api()
      .get(`/api/v1/deliveries/${deliveryId}/tracking`)
      .set(auth(riderTwo))
      .expect(200);
    await api()
      .get(`/api/v1/deliveries/${deliveryId}/tracking`)
      .set(auth(admin))
      .expect(200);
    await api()
      .get(`/api/v1/deliveries/${deliveryId}/tracking`)
      .set(auth(riderOne))
      .expect(404);
    await api()
      .get(`/api/v1/deliveries/${deliveryId}/tracking`)
      .set(auth(other))
      .expect(404);

    await api()
      .post(`/api/v1/deliveries/${deliveryId}/location`)
      .set(auth(riderOne))
      .send({ latitude: 6.5, longitude: 3.4 })
      .expect(404);

    await api().get('/api/v1/notifications').expect(401);
  });
});
