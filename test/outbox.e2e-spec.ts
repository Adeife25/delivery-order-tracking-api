import { jest } from '@jest/globals';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import request from 'supertest';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  createTestApp,
  registerCustomer,
  resetDatabase,
} from './helpers/test-app';

interface Session {
  accessToken: string;
  user: { id: string };
}

describe('Transactional notification outbox (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let customer: Session;

  const password = 'strong-password-123';

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
    await resetDatabase(prisma);

    customer = await registerCustomer(app, {
      fullName: 'Outbox Customer',
      email: 'outbox-customer@example.com',
      password,
    });
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  it('rolls back the order when its notification cannot be persisted', async () => {
    const notifications = app.get(NotificationsService);
    const failure = jest
      .spyOn(notifications, 'createInTransaction')
      .mockRejectedValue(new Error('notification insert failed'));

    try {
      await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({
          pickupAddress: '12 Marina Road, Lagos',
          deliveryAddress: '45 Adeola Odeku Street, Lagos',
          packageDescription: 'Small sealed carton',
        })
        .expect(500);

      await expect(prisma.order.count()).resolves.toBe(0);
    } finally {
      failure.mockRestore();
    }
  });
});
