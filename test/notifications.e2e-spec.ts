import { jest } from '@jest/globals';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { EmailSender } from '../src/notifications/email.sender';
import { NotificationsQueue } from '../src/notifications/notifications.queue';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  createTestApp,
  registerCustomer,
  resetDatabase,
} from './helpers/test-app';

interface NotificationRow {
  id: string;
  status: string;
  attempts: number;
  nextAttemptAt: Date | null;
}

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

describe('Notification queue (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let notifications: NotificationsService;
  let queue: NotificationsQueue;
  let emailSend: jest.Mock;
  let userId: string;

  const password = 'strong-password-123';

  async function waitForNotification(
    id: string,
    predicate: (notification: NotificationRow) => boolean,
    timeout = 15_000,
  ): Promise<NotificationRow> {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const notification = (await prisma.notification.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          attempts: true,
          nextAttemptAt: true,
        },
      })) as NotificationRow | null;

      if (notification && predicate(notification)) {
        return notification;
      }

      await sleep(50);
    }

    throw new Error(`Timed out waiting for notification ${id}`);
  }

  beforeAll(async () => {
    emailSend = jest.fn();
    const testApp = await createTestApp({
      emailSender: { send: emailSend } as unknown as EmailSender,
    });
    app = testApp.app;
    prisma = testApp.prisma;
    await resetDatabase(prisma);

    notifications = app.get(NotificationsService);
    queue = app.get(NotificationsQueue);

    const customer = await registerCustomer(app, {
      fullName: 'Notification Customer',
      email: 'notifications-customer@example.com',
      password,
    });
    userId = customer.user.id;
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  it('retries a failed notification after its database backoff', async () => {
    emailSend.mockClear();
    emailSend
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(undefined);

    const notificationId = await notifications.createInTransaction(prisma, {
      userId,
      type: 'ORDER_CREATED',
      title: 'Order created',
      message: 'Your order has been received.',
    });

    await notifications.enqueue([notificationId]);

    const failed = await waitForNotification(
      notificationId,
      (notification) =>
        notification.attempts === 1 &&
        notification.nextAttemptAt !== null &&
        notification.status === 'PENDING',
    );

    await prisma.notification.update({
      where: { id: notificationId },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });

    await notifications.retryPending();

    const sent = await waitForNotification(
      notificationId,
      (notification) => notification.status === 'SENT',
    );

    expect(failed.attempts).toBe(1);
    expect(sent.attempts).toBe(2);
    expect(emailSend).toHaveBeenCalledTimes(2);
  });

  it('delivers a notification only once when duplicate jobs are queued', async () => {
    emailSend.mockClear();
    emailSend.mockResolvedValue(undefined);

    const notificationId = await notifications.createInTransaction(prisma, {
      userId,
      type: 'DELIVERY_ACCEPTED',
      title: 'Delivery accepted',
      message: 'The rider accepted your delivery.',
    });

    await Promise.all([
      queue.enqueue(notificationId),
      queue.enqueue(notificationId),
    ]);

    const sent = await waitForNotification(
      notificationId,
      (notification) => notification.status === 'SENT',
    );

    expect(sent.attempts).toBe(1);
    expect(emailSend).toHaveBeenCalledTimes(1);
  });
});
