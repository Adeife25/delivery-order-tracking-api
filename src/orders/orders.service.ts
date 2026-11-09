import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus, Prisma, UserRole } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { ListOrdersQueryDto } from './dto/list-orders-query.dto';
import { generateOrderNumber } from './order-number.generator';
import {
  OrderHistoryView,
  orderHistorySelect,
  orderSelect,
  OrderView,
} from './orders.select';

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
}

@Injectable()
export class OrdersService {
  private readonly defaultDeliveryFee: string;
  private readonly defaultCurrency: string;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {
    this.defaultDeliveryFee = config.getOrThrow<string>('DEFAULT_DELIVERY_FEE');
    this.defaultCurrency = config.getOrThrow<string>('DEFAULT_CURRENCY');
  }

  async create(customerId: string, dto: CreateOrderDto): Promise<OrderView> {
    this.assertCoordinatePair(
      dto.pickupLatitude,
      dto.pickupLongitude,
      'Pickup',
    );
    this.assertCoordinatePair(
      dto.deliveryLatitude,
      dto.deliveryLongitude,
      'Delivery',
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const result = await this.prisma.$transaction(async (tx) => {
          const order = await tx.order.create({
            data: {
              orderNumber: generateOrderNumber(),
              customerId,
              pickupAddress: dto.pickupAddress,
              pickupLatitude: dto.pickupLatitude,
              pickupLongitude: dto.pickupLongitude,
              deliveryAddress: dto.deliveryAddress,
              deliveryLatitude: dto.deliveryLatitude,
              deliveryLongitude: dto.deliveryLongitude,
              packageDescription: dto.packageDescription,
              deliveryInstructions: dto.deliveryInstructions,
              deliveryFee: this.defaultDeliveryFee,
              currency: this.defaultCurrency,
              status: OrderStatus.PENDING_PAYMENT,
            },
            select: orderSelect,
          });

          const notificationId = await this.notifications.createInTransaction(
            tx,
            {
              userId: customerId,
              type: 'ORDER_CREATED',
              title: 'Order created',
              message: `Your order ${order.orderNumber} has been received and is awaiting payment.`,
            },
          );

          return { order, notificationId };
        });

        void this.notifications.enqueue([result.notificationId]);

        return result.order;
      } catch (error) {
        if (!isUniqueConstraintError(error) || attempt === 4) {
          throw error;
        }
      }
    }

    throw new ConflictException('Could not generate a unique order number');
  }

  async list(user: AuthenticatedUser, query: ListOrdersQueryDto) {
    const where: Prisma.OrderWhereInput = {};

    if (user.role === UserRole.CUSTOMER) {
      where.customerId = user.id;
    } else if (user.role === UserRole.RIDER) {
      where.delivery = { is: { riderId: user.id } };
    }

    if (query.status) {
      where.status = query.status;
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: orderSelect,
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getById(user: AuthenticatedUser, id: string): Promise<OrderView> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: orderSelect,
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    this.assertCanView(user, order.customerId, order.delivery?.riderId);

    return order;
  }

  async cancel(user: AuthenticatedUser, id: string): Promise<OrderView> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: { id: true, customerId: true, status: true },
    });

    if (
      !order ||
      (user.role !== UserRole.ADMIN && order.customerId !== user.id)
    ) {
      throw new NotFoundException('Order not found');
    }

    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new ConflictException(
        'Only orders pending payment can be cancelled',
      );
    }

    const result = await this.prisma.order.updateMany({
      where: {
        id,
        status: OrderStatus.PENDING_PAYMENT,
      },
      data: { status: OrderStatus.CANCELLED },
    });

    if (result.count !== 1) {
      throw new ConflictException(
        'Only orders pending payment can be cancelled',
      );
    }

    return this.prisma.order.findUniqueOrThrow({
      where: { id },
      select: orderSelect,
    });
  }

  async getHistory(user: AuthenticatedUser, id: string) {
    const order: OrderHistoryView | null = await this.prisma.order.findUnique({
      where: { id },
      select: orderHistorySelect,
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    this.assertCanView(user, order.customerId, order.delivery?.riderId);

    return {
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      },
      delivery: order.delivery
        ? {
            id: order.delivery.id,
            status: order.delivery.status,
            createdAt: order.delivery.createdAt,
            updatedAt: order.delivery.updatedAt,
          }
        : null,
      deliveryHistory: order.delivery?.statusHistory ?? [],
    };
  }

  private assertCanView(
    user: AuthenticatedUser,
    customerId: string,
    riderId: string | null | undefined,
  ): void {
    if (user.role === UserRole.ADMIN) {
      return;
    }

    if (customerId === user.id) {
      return;
    }

    if (riderId && riderId === user.id) {
      return;
    }

    throw new NotFoundException('Order not found');
  }

  private assertCoordinatePair(
    latitude: number | undefined,
    longitude: number | undefined,
    label: string,
  ): void {
    if ((latitude === undefined) !== (longitude === undefined)) {
      throw new BadRequestException(
        `${label} latitude and longitude must be provided together`,
      );
    }
  }
}
