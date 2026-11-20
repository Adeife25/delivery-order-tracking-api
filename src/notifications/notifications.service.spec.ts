import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { DatabaseService } from '../database/database.service';
import { NotificationStatus } from '../database/enums';
import type { EmailSender } from './email.sender';
import type { NotificationsQueue } from './notifications.queue';

type AsyncMock = jest.Mock<(...args: unknown[]) => Promise<unknown>>;

interface FakeQuery {
  populate: jest.Mock;
  sort: jest.Mock;
  skip: jest.Mock;
  limit: jest.Mock;
  select: jest.Mock;
  lean: AsyncMock;
}

function createFakeQuery(): FakeQuery {
  const query = {
    populate: jest.fn(),
    sort: jest.fn(),
    skip: jest.fn(),
    limit: jest.fn(),
    select: jest.fn(),
    lean: jest.fn(),
  } as unknown as FakeQuery;

  query.populate.mockReturnValue(query);
  query.sort.mockReturnValue(query);
  query.skip.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.select.mockReturnValue(query);
  query.lean.mockResolvedValue([]);
  return query;
}

const notificationModel = {
  create: jest.fn(async (): Promise<unknown> => []),
  findById: jest.fn((): unknown => ({})),
  find: jest.fn((): unknown => ({})),
  updateOne: jest.fn(async (): Promise<unknown> => ({ modifiedCount: 1 })),
  countDocuments: jest.fn(async (): Promise<unknown> => 0),
};

jest.unstable_mockModule('../database/database.service', () => ({
  DatabaseService: class {},
  isDuplicateKeyError: () => false,
  sessionOptions: () => ({}),
}));
jest.unstable_mockModule('../database/models', () => ({
  NotificationModel: notificationModel,
}));

const { NotificationsService } = await import('./notifications.service');

function notification(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'notification-1',
    userId: 'user-1',
    type: 'DELIVERY_UPDATE',
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
  let service: InstanceType<typeof NotificationsService>;
  let emailSender: { send: AsyncMock };
  let queue: {
    isEnabled: jest.Mock;
    enqueue: AsyncMock;
    scheduleSweep: jest.Mock;
  };
  let logger: { mockRestore(): void };
  let findByIdQuery: FakeQuery;
  let findQuery: FakeQuery;

  beforeEach(() => {
    logger = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    findByIdQuery = createFakeQuery();
    findQuery = createFakeQuery();
    notificationModel.create
      .mockReset()
      .mockResolvedValue([{ _id: 'notification-1' }]);
    notificationModel.findById.mockReset().mockReturnValue(findByIdQuery);
    notificationModel.find.mockReset().mockReturnValue(findQuery);
    notificationModel.updateOne
      .mockReset()
      .mockResolvedValue({ modifiedCount: 1 });
    findByIdQuery.lean.mockResolvedValue(notification());
    findQuery.lean.mockResolvedValue([]);

    emailSender = { send: jest.fn(async (): Promise<unknown> => undefined) };
    queue = {
      isEnabled: jest.fn(() => false),
      enqueue: jest.fn(async (): Promise<unknown> => false),
      scheduleSweep: jest.fn(),
    };
    service = new NotificationsService(
      {} as DatabaseService,
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
    expect(notificationModel.updateOne).toHaveBeenNthCalledWith(
      1,
      {
        _id: 'notification-1',
        status: NotificationStatus.PENDING,
        attempts: 0,
        $or: [
          { nextAttemptAt: null },
          { nextAttemptAt: { $lte: expect.any(Date) } },
        ],
      },
      { $inc: { attempts: 1 } },
    );
    expect(notificationModel.updateOne).toHaveBeenNthCalledWith(
      2,
      { _id: 'notification-1', status: NotificationStatus.PENDING },
      {
        $set: {
          status: NotificationStatus.SENT,
          sentAt: expect.any(Date),
          nextAttemptAt: null,
        },
      },
    );
  });

  it('schedules a retry after a failed attempt', async () => {
    emailSender.send.mockRejectedValue(new Error('temporary failure'));

    await service.dispatch('notification-1');

    expect(emailSender.send).toHaveBeenCalledTimes(1);
    expect(notificationModel.updateOne).toHaveBeenNthCalledWith(
      2,
      { _id: 'notification-1', status: NotificationStatus.PENDING },
      { $set: { nextAttemptAt: expect.any(Date) } },
    );
  });

  it('marks the notification as failed after the final attempt', async () => {
    findByIdQuery.lean.mockResolvedValue(notification({ attempts: 2 }));
    emailSender.send.mockRejectedValue(new Error('permanent failure'));

    await service.dispatch('notification-1');

    expect(notificationModel.updateOne).toHaveBeenNthCalledWith(
      2,
      { _id: 'notification-1', status: NotificationStatus.PENDING },
      { $set: { status: NotificationStatus.FAILED, nextAttemptAt: null } },
    );
  });

  it('does not send a notification before its next attempt time', async () => {
    findByIdQuery.lean.mockResolvedValue(
      notification({ nextAttemptAt: new Date(Date.now() + 60_000) }),
    );

    await service.dispatch('notification-1');

    expect(emailSender.send).not.toHaveBeenCalled();
    expect(notificationModel.updateOne).not.toHaveBeenCalled();
  });

  it('creates pending notifications with the supplied session', async () => {
    notificationModel.create.mockResolvedValue([{ _id: 'notification-2' }]);
    const session = {} as Parameters<
      InstanceType<typeof NotificationsService>['createInTransaction']
    >[1];

    await expect(
      service.createInTransaction(
        {
          userId: 'user-1',
          type: 'ORDER_CREATED',
          title: 'Order created',
          message: 'Your order has been received.',
        },
        session,
      ),
    ).resolves.toBe('notification-2');

    expect(notificationModel.create).toHaveBeenCalledWith(
      [
        {
          userId: 'user-1',
          type: 'ORDER_CREATED',
          title: 'Order created',
          message: 'Your order has been received.',
          status: NotificationStatus.PENDING,
          attempts: 0,
        },
      ],
      { session },
    );
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
    findQuery.lean.mockResolvedValue([{ _id: 'notification-1' }]);
    const dispatch = jest
      .spyOn(service, 'dispatch')
      .mockResolvedValue(undefined);

    await service.retryPending();

    expect(dispatch).toHaveBeenCalledWith('notification-1');
    expect(notificationModel.find).toHaveBeenCalledWith({
      status: NotificationStatus.PENDING,
      $or: [
        { nextAttemptAt: null },
        { nextAttemptAt: { $lte: expect.any(Date) } },
      ],
    });
  });
});
