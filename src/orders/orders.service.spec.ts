import { jest } from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DatabaseService } from '../database/database.service';
import { OrderStatus, UserRole } from '../database/enums';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import type { NotificationsService } from '../notifications/notifications.service';
import type { CreateOrderDto } from './dto/create-order.dto';

type AsyncMock = jest.Mock<(...args: unknown[]) => Promise<unknown>>;

interface FakeQuery {
  sort: jest.Mock;
  skip: jest.Mock;
  limit: jest.Mock;
  populate: jest.Mock;
  select: jest.Mock;
  distinct: AsyncMock;
  lean: AsyncMock;
}

function createFakeQuery(): FakeQuery {
  const query = {
    sort: jest.fn(),
    skip: jest.fn(),
    limit: jest.fn(),
    populate: jest.fn(),
    select: jest.fn(),
    distinct: jest.fn(),
    lean: jest.fn(),
  } as unknown as FakeQuery;

  query.sort.mockReturnValue(query);
  query.skip.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.populate.mockReturnValue(query);
  query.select.mockReturnValue(query);
  query.distinct.mockResolvedValue([]);
  query.lean.mockResolvedValue([]);
  return query;
}

const orderModel = {
  create: jest.fn(async (): Promise<unknown> => []),
  find: jest.fn((): unknown => createFakeQuery()),
  findById: jest.fn((): unknown => createFakeQuery()),
  countDocuments: jest.fn(async (): Promise<unknown> => 0),
  updateOne: jest.fn(async (): Promise<unknown> => ({ modifiedCount: 1 })),
};
const deliveryModel = { find: jest.fn((): unknown => createFakeQuery()) };
const database = {
  withTransaction: jest.fn(
    async (
      operation: (session: unknown) => Promise<unknown>,
    ): Promise<unknown> => operation({}),
  ),
};

jest.unstable_mockModule('../database/database.service', () => ({
  DatabaseService: class {},
  isDuplicateKeyError: (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === 11000,
  sessionOptions: () => ({}),
}));
jest.unstable_mockModule('../database/models', () => ({
  OrderModel: orderModel,
  DeliveryModel: deliveryModel,
}));
jest.unstable_mockModule('../notifications/notifications.service', () => ({
  NotificationsService: class {},
}));

const { OrdersService } = await import('./orders.service');

describe('OrdersService', () => {
  let service: InstanceType<typeof OrdersService>;
  let notifications: {
    createInTransaction: AsyncMock;
    enqueue: AsyncMock;
  };
  let findQuery: FakeQuery;
  let findByIdQuery: FakeQuery;
  let deliveryFindQuery: FakeQuery;

  const customer: AuthenticatedUser = {
    id: '64b7f9d2e1a2b3c4d5e6f700',
    email: 'customer@example.com',
    role: UserRole.CUSTOMER,
  };
  const otherCustomer: AuthenticatedUser = {
    id: '64b7f9d2e1a2b3c4d5e6f701',
    email: 'other@example.com',
    role: UserRole.CUSTOMER,
  };
  const admin: AuthenticatedUser = {
    id: '64b7f9d2e1a2b3c4d5e6f702',
    email: 'admin@example.com',
    role: UserRole.ADMIN,
  };
  const rider: AuthenticatedUser = {
    id: '64b7f9d2e1a2b3c4d5e6f703',
    email: 'rider@example.com',
    role: UserRole.RIDER,
  };
  const createOrderDto: CreateOrderDto = {
    pickupAddress: '12 Marina Road, Lagos',
    deliveryAddress: '45 Adeola Odeku Street, Lagos',
    packageDescription: 'Small sealed carton',
  };

  function orderDocument(overrides: Record<string, unknown> = {}) {
    const doc = {
      _id: 'order-id',
      orderNumber: 'ORD-20260101-ABC123',
      customerId: customer.id,
      pickupAddress: createOrderDto.pickupAddress,
      pickupLatitude: null,
      pickupLongitude: null,
      deliveryAddress: createOrderDto.deliveryAddress,
      deliveryLatitude: null,
      deliveryLongitude: null,
      packageDescription: createOrderDto.packageDescription,
      deliveryInstructions: null,
      deliveryFee: '1500.00',
      currency: 'NGN',
      status: OrderStatus.PENDING_PAYMENT,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      delivery: null,
      ...overrides,
    };

    return { ...doc, toObject: () => doc };
  }

  beforeAll(() => {
    const config = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'DEFAULT_DELIVERY_FEE') {
          return '1500.00';
        }
        if (key === 'DEFAULT_CURRENCY') {
          return 'NGN';
        }
        return undefined;
      }),
    } as unknown as ConfigService;

    notifications = {
      createInTransaction: jest.fn(async (): Promise<unknown> => ''),
      enqueue: jest.fn(async (): Promise<unknown> => undefined),
    };

    service = new OrdersService(
      config,
      database as unknown as DatabaseService,
      notifications as unknown as NotificationsService,
    );
  });

  beforeEach(() => {
    findQuery = createFakeQuery();
    findByIdQuery = createFakeQuery();
    deliveryFindQuery = createFakeQuery();

    orderModel.create.mockReset().mockResolvedValue([orderDocument()]);
    orderModel.find.mockReset().mockReturnValue(findQuery);
    orderModel.findById.mockReset().mockReturnValue(findByIdQuery);
    orderModel.countDocuments.mockReset().mockResolvedValue(0);
    orderModel.updateOne.mockReset().mockResolvedValue({ modifiedCount: 1 });
    deliveryModel.find.mockReset().mockReturnValue(deliveryFindQuery);
    database.withTransaction
      .mockReset()
      .mockImplementation(
        async (operation: (session: unknown) => Promise<unknown>) =>
          operation({}),
      );
    notifications.createInTransaction
      .mockReset()
      .mockResolvedValue('notification-id');
    notifications.enqueue.mockReset().mockResolvedValue(undefined);
  });

  describe('create', () => {
    it('creates a pending-payment order with configured pricing', async () => {
      const result = await service.create(customer.id, createOrderDto);

      expect(orderModel.create).toHaveBeenCalledTimes(1);
      const calls = orderModel.create.mock.calls as unknown as Array<
        [Array<Record<string, unknown>>]
      >;
      const args = calls[0][0];
      expect(args[0]).toMatchObject({
        customerId: customer.id,
        pickupAddress: createOrderDto.pickupAddress,
        deliveryAddress: createOrderDto.deliveryAddress,
        packageDescription: createOrderDto.packageDescription,
        deliveryFee: '1500.00',
        currency: 'NGN',
        status: OrderStatus.PENDING_PAYMENT,
      });
      expect(args[0].orderNumber).toEqual(
        expect.stringMatching(/^ORD-\d{8}-[A-Z0-9]{6}$/),
      );
      expect(result).toMatchObject({ id: 'order-id' });
      expect(notifications.createInTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ userId: customer.id }),
        expect.anything(),
      );
    });

    it('requires coordinate pairs', async () => {
      await expect(
        service.create(customer.id, {
          ...createOrderDto,
          pickupLatitude: 6.45,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(orderModel.create).not.toHaveBeenCalled();
    });

    it('retries when an order number collides', async () => {
      orderModel.create
        .mockRejectedValueOnce({ code: 11000 })
        .mockResolvedValue([orderDocument()]);

      await service.create(customer.id, createOrderDto);

      expect(orderModel.create).toHaveBeenCalledTimes(2);
    });
  });

  describe('list', () => {
    it('scopes customers to their own orders', async () => {
      const result = await service.list(customer, { page: 1, limit: 20 });

      expect(orderModel.find).toHaveBeenCalledWith({ customerId: customer.id });
      expect(result.meta).toEqual({
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      });
    });

    it('allows admins to list all orders', async () => {
      await service.list(admin, { page: 1, limit: 20 });

      expect(orderModel.find).toHaveBeenCalledWith({});
    });

    it('scopes riders to their assigned deliveries', async () => {
      await service.list(rider, { page: 1, limit: 20 });

      expect(deliveryModel.find).toHaveBeenCalledWith({ riderId: rider.id });
      expect(deliveryFindQuery.distinct).toHaveBeenCalledWith('orderId');
      expect(orderModel.find).toHaveBeenCalledWith({ _id: { $in: [] } });
    });

    it('applies status filters and pagination', async () => {
      orderModel.countDocuments.mockResolvedValue(21);

      const result = await service.list(customer, {
        page: 2,
        limit: 10,
        status: OrderStatus.PENDING_PAYMENT,
      });

      expect(orderModel.find).toHaveBeenCalledWith({
        customerId: customer.id,
        status: OrderStatus.PENDING_PAYMENT,
      });
      expect(findQuery.skip).toHaveBeenCalledWith(10);
      expect(findQuery.limit).toHaveBeenCalledWith(10);
      expect(result.meta.totalPages).toBe(3);
    });
  });

  describe('getById', () => {
    it('returns an order to its owner', async () => {
      findByIdQuery.lean.mockResolvedValue(orderDocument());

      await expect(
        service.getById(customer, 'order-id'),
      ).resolves.toMatchObject({ id: 'order-id', customerId: customer.id });
    });

    it('returns an order to an admin', async () => {
      findByIdQuery.lean.mockResolvedValue(orderDocument());

      await expect(service.getById(admin, 'order-id')).resolves.toMatchObject({
        id: 'order-id',
      });
    });

    it('returns an order to its assigned rider', async () => {
      findByIdQuery.lean.mockResolvedValue(
        orderDocument({ delivery: { riderId: rider.id } }),
      );

      await expect(service.getById(rider, 'order-id')).resolves.toMatchObject({
        id: 'order-id',
      });
    });

    it('hides another customer order', async () => {
      findByIdQuery.lean.mockResolvedValue(orderDocument());

      await expect(
        service.getById(otherCustomer, 'order-id'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns not found for a missing order', async () => {
      findByIdQuery.lean.mockResolvedValue(null);

      await expect(
        service.getById(customer, 'order-id'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('cancel', () => {
    it('cancels a pending-payment order owned by the customer', async () => {
      findByIdQuery.lean
        .mockResolvedValueOnce(orderDocument())
        .mockResolvedValueOnce(
          orderDocument({ status: OrderStatus.CANCELLED }),
        );

      const result = await service.cancel(customer, 'order-id');

      expect(orderModel.updateOne).toHaveBeenCalledWith(
        { _id: 'order-id', status: OrderStatus.PENDING_PAYMENT },
        { $set: { status: OrderStatus.CANCELLED } },
      );
      expect(result).toMatchObject({
        id: 'order-id',
        status: OrderStatus.CANCELLED,
      });
    });

    it('allows an admin to cancel a pending order', async () => {
      findByIdQuery.lean.mockResolvedValue(
        orderDocument({ customerId: otherCustomer.id }),
      );

      await expect(service.cancel(admin, 'order-id')).resolves.toBeTruthy();
    });

    it('hides another customer order', async () => {
      findByIdQuery.lean.mockResolvedValue(
        orderDocument({ customerId: otherCustomer.id }),
      );

      await expect(service.cancel(customer, 'order-id')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects non-pending orders', async () => {
      findByIdQuery.lean.mockResolvedValue(
        orderDocument({ status: OrderStatus.CONFIRMED }),
      );

      await expect(service.cancel(customer, 'order-id')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(orderModel.updateOne).not.toHaveBeenCalled();
    });

    it('rejects a concurrent cancellation that lost the race', async () => {
      findByIdQuery.lean.mockResolvedValue(orderDocument());
      orderModel.updateOne.mockResolvedValue({ modifiedCount: 0 });

      await expect(service.cancel(customer, 'order-id')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('getHistory', () => {
    it('returns order and empty delivery history when no delivery exists', async () => {
      findByIdQuery.lean.mockResolvedValue(orderDocument());

      const result = await service.getHistory(customer, 'order-id');

      expect(result.order).toMatchObject({
        id: 'order-id',
        status: OrderStatus.PENDING_PAYMENT,
      });
      expect(result.delivery).toBeNull();
      expect(result.deliveryHistory).toEqual([]);
    });
  });
});
