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

interface StatusEvent {
  deliveryId: string;
  status: string;
}

describe('Socket.IO Redis adapter (e2e)', () => {
  let appA: INestApplication<App>;
  let appB: INestApplication<App>;
  let prisma: PrismaService;
  let socketUrlB: string;
  let customerSocket: Socket | undefined;

  const password = 'strong-password-123';
  const customerEmail = 'adapter-customer@example.com';
  const riderEmail = 'adapter-rider@example.com';
  const adminEmail = 'adapter-admin@example.com';

  let customer: Session;
  let rider: Session;
  let admin: Session;
  let deliveryId: string;

  const apiA = () => request(appA.getHttpServer());
  const auth = (session: Session) => ({
    Authorization: `Bearer ${session.accessToken}`,
  });

  async function login(email: string): Promise<Session> {
    const response = await apiA()
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    return response.body as Session;
  }

  function connectAs(token: string): Promise<Socket> {
    const socket = io(`${socketUrlB}/tracking`, {
      auth: { token },
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

  beforeAll(async () => {
    const first = await createTestApp();
    const second = await createTestApp();
    appA = first.app;
    appB = second.app;
    prisma = first.prisma;

    await resetDatabase(prisma);

    await appA.listen(0);
    await appB.listen(0);
    socketUrlB = `http://127.0.0.1:${new URL(await appB.getUrl()).port}`;

    customer = await registerCustomer(appA, {
      fullName: 'Adapter Customer',
      email: customerEmail,
      password,
    });
    await registerCustomer(appA, {
      fullName: 'Adapter Rider',
      email: riderEmail,
      password,
    });
    await registerCustomer(appA, {
      fullName: 'Adapter Admin',
      email: adminEmail,
      password,
    });

    await prisma.user.update({
      where: { email: riderEmail },
      data: { role: 'RIDER' },
    });
    await prisma.user.update({
      where: { email: adminEmail },
      data: { role: 'ADMIN' },
    });

    rider = await login(riderEmail);
    admin = await login(adminEmail);
  });

  afterAll(async () => {
    customerSocket?.disconnect();
    await resetDatabase(prisma);
    await appA.close();
    await appB.close();
  });

  it('broadcasts delivery updates to sockets connected to another instance', async () => {
    const order = await apiA()
      .post('/api/v1/orders')
      .set(auth(customer))
      .send({
        pickupAddress: '12 Marina Road, Lagos',
        deliveryAddress: '45 Adeola Odeku Street, Lagos',
        packageDescription: 'Small sealed carton',
      })
      .expect(201);

    await prisma.order.update({
      where: { id: order.body.id as string },
      data: { status: 'CONFIRMED' },
    });

    const assignment = await apiA()
      .post(`/api/v1/admin/orders/${order.body.id as string}/assign`)
      .set(auth(admin))
      .send({ riderId: rider.user.id })
      .expect(200);
    deliveryId = assignment.body.id as string;

    customerSocket = await connectAs(customer.accessToken);
    await expect(
      joinDelivery(customerSocket, deliveryId),
    ).resolves.toMatchObject({ joined: true, deliveryId });

    const accepted = waitForEvent<StatusEvent>(
      customerSocket,
      'delivery:status_updated',
    );

    await apiA()
      .post(`/api/v1/deliveries/${deliveryId}/accept`)
      .set(auth(rider))
      .expect(200);

    await expect(accepted).resolves.toMatchObject({
      deliveryId,
      status: 'ACCEPTED',
    });
  });
});
