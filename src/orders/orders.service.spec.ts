import { jest } from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus, UserRole } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrdersService } from './orders.service';

describe('OrdersService', () => {
  let service: OrdersService;
  let notifications: {
    createInTransaction: jest.Mock;
    enqueue: jest.Mock;
  };
  let prisma: {
    order: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  const customer: AuthenticatedUser = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'customer@example.com',
    role: UserRole.CUSTOMER,
  };
  const otherCustomer: AuthenticatedUser = {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'other@example.com',
    role: UserRole.CUSTOMER,
  };
  const admin: AuthenticatedUser = {
    id: '33333333-3333-4333-8333-333333333333',
    email: 'admin@example.com',
    role: UserRole.ADMIN,
  };
  const rider: AuthenticatedUser = {
    id: '44444444-4444-4444-8444-444444444444',
    email: 'rider@example.com',
    role: UserRole.RIDER,
  };
  const createOrderDto: CreateOrderDto = {
    pickupAddress: '12 Marina Road, Lagos',
    deliveryAddress: '45 Adeola Odeku Street, Lagos',
    packageDescription: 'Small sealed carton',
  };

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

    prisma = {
      order: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        updateMany: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
      $transaction: jest.fn((operation: unknown) => {
        if (typeof operation === 'function') {
          return (operation as (tx: unknown) => unknown)(prisma);
        }
        if (Array.isArray(operation)) {
          return Promise.all(operation);
        }
        return undefined;
      }),
    };

    notifications = {
      createInTransaction: jest.fn().mockResolvedValue('notification-id'),
      enqueue: jest.fn().mockResolvedValue(undefined),
    };

    service = new OrdersService(
      config,
      prisma as unknown as PrismaService,
      notifications as unknown as NotificationsService,
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('creates a pending-payment order with configured pricing', async () => {
      prisma.order.create.mockResolvedValue({ id: 'order-id' });

      await service.create(customer.id, createOrderDto);

      expect(prisma.order.create).toHaveBeenCalledTimes(1);
      const args = prisma.order.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(args.data).toMatchObject({
        customerId: customer.id,
        pickupAddress: createOrderDto.pickupAddress,
        deliveryAddress: createOrderDto.deliveryAddress,
        packageDescription: createOrderDto.packageDescription,
        deliveryFee: '1500.00',
        currency: 'NGN',
        status: OrderStatus.PENDING_PAYMENT,
      });
      expect(args.data.orderNumber).toMatch(/^ORD-\d{8}-[A-Z0-9]{6}$/);
    });

    it('requires coordinate pairs', async () => {
      await expect(
        service.create(customer.id, {
          ...createOrderDto,
          pickupLatitude: 6.45,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('retries when an order number collides', async () => {
      prisma.order.create
        .mockRejectedValueOnce({ code: 'P2002' })
        .mockResolvedValueOnce({ id: 'order-id' });

      await service.create(customer.id, createOrderDto);

      expect(prisma.order.create).toHaveBeenCalledTimes(2);
    });
  });

  describe('list', () => {
    beforeEach(() => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);
    });

    it('scopes customers to their own orders', async () => {
      const result = await service.list(customer, { page: 1, limit: 20 });

      const args = prisma.order.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(args.where).toEqual({ customerId: customer.id });
      expect(result.meta).toEqual({
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      });
    });

    it('allows admins to list all orders', async () => {
      await service.list(admin, { page: 1, limit: 20 });

      const args = prisma.order.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(args.where).toEqual({});
    });

    it('scopes riders to their assigned deliveries', async () => {
      await service.list(rider, { page: 1, limit: 20 });

      const args = prisma.order.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(args.where).toEqual({
        delivery: { is: { riderId: rider.id } },
      });
    });

    it('applies status filters and pagination', async () => {
      prisma.order.count.mockResolvedValue(21);

      const result = await service.list(customer, {
        page: 2,
        limit: 10,
        status: OrderStatus.PENDING_PAYMENT,
      });

      const args = prisma.order.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
        skip: number;
        take: number;
      };
      expect(args.where).toEqual({
        customerId: customer.id,
        status: OrderStatus.PENDING_PAYMENT,
      });
      expect(args.skip).toBe(10);
      expect(args.take).toBe(10);
      expect(result.meta.totalPages).toBe(3);
    });
  });

  describe('getById', () => {
    const order = {
      id: 'order-id',
      customerId: customer.id,
      delivery: null,
    };

    it('returns an order to its owner', async () => {
      prisma.order.findUnique.mockResolvedValue(order);

      await expect(service.getById(customer, 'order-id')).resolves.toBe(order);
    });

    it('returns an order to an admin', async () => {
      prisma.order.findUnique.mockResolvedValue(order);

      await expect(service.getById(admin, 'order-id')).resolves.toBe(order);
    });

    it('returns an order to its assigned rider', async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...order,
        delivery: { riderId: rider.id },
      });

      await expect(service.getById(rider, 'order-id')).resolves.toBeTruthy();
    });

    it('hides another customer order', async () => {
      prisma.order.findUnique.mockResolvedValue(order);

      await expect(
        service.getById(otherCustomer, 'order-id'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns not found for a missing order', async () => {
      prisma.order.findUnique.mockResolvedValue(null);

      await expect(
        service.getById(customer, 'order-id'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('cancel', () => {
    it('cancels a pending-payment order owned by the customer', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-id',
        customerId: customer.id,
        status: OrderStatus.PENDING_PAYMENT,
      });
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'order-id',
        status: OrderStatus.CANCELLED,
      });

      const result = await service.cancel(customer, 'order-id');

      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'order-id', status: OrderStatus.PENDING_PAYMENT },
        data: { status: OrderStatus.CANCELLED },
      });
      expect(result).toMatchObject({ status: OrderStatus.CANCELLED });
    });

    it('allows an admin to cancel a pending order', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-id',
        customerId: otherCustomer.id,
        status: OrderStatus.PENDING_PAYMENT,
      });
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'order-id',
        status: OrderStatus.CANCELLED,
      });

      await expect(service.cancel(admin, 'order-id')).resolves.toBeTruthy();
    });

    it('hides another customer order', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-id',
        customerId: otherCustomer.id,
        status: OrderStatus.PENDING_PAYMENT,
      });

      await expect(service.cancel(customer, 'order-id')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects non-pending orders', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-id',
        customerId: customer.id,
        status: OrderStatus.CONFIRMED,
      });

      await expect(service.cancel(customer, 'order-id')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a concurrent cancellation that lost the race', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-id',
        customerId: customer.id,
        status: OrderStatus.PENDING_PAYMENT,
      });
      prisma.order.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.cancel(customer, 'order-id')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('getHistory', () => {
    it('returns order and empty delivery history when no delivery exists', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-id',
        orderNumber: 'ORD-20260101-ABC123',
        customerId: customer.id,
        status: OrderStatus.PENDING_PAYMENT,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        delivery: null,
      });

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
