import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { NotificationStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailSender } from './email.sender';
import { NotificationsQueue } from './notifications.queue';
import { NotificationsService } from './notifications.service';

function notification(overrides: Record<string, unknown> = {}) {
  return {
    id: 'notification-1',
    status: NotificationStatus.PENDING,
    attempts: 0,
    nextAttemptAt: null,
    title: 'Delivery update',
    message: 'Your delivery is on the way.',
    user: { email: 'customer@example.com' },
    ...overrides,
  };
}

describe('NotificationsService', () => {
  let prisma: {
    notification: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let emailSender: { send: jest.Mock };
  let queue: {
    isEnabled: jest.Mock;
    enqueue: jest.Mock;
    scheduleSweep: jest.Mock;
  };
  let service: NotificationsService;
  let logger: jest.SpyInstance;

  beforeEach(() => {
    logger = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    prisma = {
      notification: {
        create: jest.fn().mockResolvedValue({ id: 'notification-1' }),
        findUnique: jest.fn().mockResolvedValue(notification()),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 1 }),
      },
    };
    emailSender = { send: jest.fn() };
    queue = {
      isEnabled: jest.fn().mockReturnValue(false),
      enqueue: jest.fn().mockResolvedValue(false),
      scheduleSweep: jest.fn(),
    };
    service = new NotificationsService(
      prisma as unknown as PrismaService,
      emailSender as unknown as EmailSender,
      queue as unknown as NotificationsQueue,
    );
  });

  afterEach(() => {
    logger.mockRestore();
  });

  it('sends the notification and marks it as sent', async () => {
    await service.dispatch('notification-1');

    expect(emailSender.send).toHaveBeenCalledTimes(1);
    expect(prisma.notification.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'notification-1',
        status: NotificationStatus.PENDING,
        attempts: 0,
        OR: [
          { nextAttemptAt: null },
          { nextAttemptAt: { lte: expect.any(Date) } },
        ],
      },
      data: { attempts: { increment: 1 } },
    });
    expect(prisma.notification.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'notification-1',
        status: NotificationStatus.PENDING,
      },
      data: {
        status: NotificationStatus.SENT,
        sentAt: expect.any(Date),
        nextAttemptAt: null,
      },
    });
  });

  it('schedules a retry after a failed attempt', async () => {
    emailSender.send.mockRejectedValue(new Error('temporary failure'));

    await service.dispatch('notification-1');

    expect(emailSender.send).toHaveBeenCalledTimes(1);
    expect(prisma.notification.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'notification-1',
        status: NotificationStatus.PENDING,
      },
      data: { nextAttemptAt: expect.any(Date) },
    });
  });

  it('marks the notification as failed after the final attempt', async () => {
    prisma.notification.findUnique.mockResolvedValue(
      notification({ attempts: 2 }),
    );
    emailSender.send.mockRejectedValue(new Error('permanent failure'));

    await service.dispatch('notification-1');

    expect(prisma.notification.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'notification-1',
        status: NotificationStatus.PENDING,
      },
      data: {
        status: NotificationStatus.FAILED,
        nextAttemptAt: null,
      },
    });
  });

  it('does not send a notification before its next attempt time', async () => {
    prisma.notification.findUnique.mockResolvedValue(
      notification({ nextAttemptAt: new Date(Date.now() + 60_000) }),
    );

    await service.dispatch('notification-1');

    expect(emailSender.send).not.toHaveBeenCalled();
    expect(prisma.notification.updateMany).not.toHaveBeenCalled();
  });

  it('creates pending notifications through the supplied transaction', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'notification-2' });

    await expect(
      service.createInTransaction(
        { notification: { create } } as unknown as Prisma.TransactionClient,
        {
          userId: 'user-1',
          type: 'ORDER_CREATED',
          title: 'Order created',
          message: 'Your order has been received.',
        },
      ),
    ).resolves.toBe('notification-2');

    expect(create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        type: 'ORDER_CREATED',
        title: 'Order created',
        message: 'Your order has been received.',
        status: NotificationStatus.PENDING,
      },
      select: { id: true },
    });
  });

  it('enqueues every notification id', async () => {
    queue.isEnabled.mockReturnValue(true);
    queue.enqueue.mockResolvedValue(true);

    await service.enqueue(['notification-1', 'notification-2']);

    expect(queue.enqueue).toHaveBeenCalledTimes(2);
    expect(queue.enqueue).toHaveBeenNthCalledWith(1, 'notification-1');
    expect(queue.enqueue).toHaveBeenNthCalledWith(2, 'notification-2');
  });

  it('retries pending notifications that are due', async () => {
    prisma.notification.findMany.mockResolvedValue([{ id: 'notification-1' }]);
    const dispatch = jest
      .spyOn(service, 'dispatch')
      .mockResolvedValue(undefined);

    await service.retryPending();

    expect(dispatch).toHaveBeenCalledWith('notification-1');
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: NotificationStatus.PENDING,
          OR: [
            { nextAttemptAt: null },
            { nextAttemptAt: { lte: expect.any(Date) } },
          ],
        },
      }),
    );
  });
});
