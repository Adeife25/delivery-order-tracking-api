import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DatabaseService,
  isDuplicateKeyError,
} from '../database/database.service';
import { OrderStatus, UserRole } from '../database/enums';
import { DeliveryModel, OrderModel } from '../database/models';
import { OrderDoc, toOrderHistoryView, toOrderView } from '../database/views';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { ListOrdersQueryDto } from './dto/list-orders-query.dto';
import { generateOrderNumber } from './order-number.generator';
import { orderHistoryPopulate, orderPopulate } from './orders.select';
import { OrderView } from './orders.select';

@Injectable()
export class OrdersService {
  private readonly defaultDeliveryFee: string;
  private readonly defaultCurrency: string;

  constructor(
    config: ConfigService,
    private readonly database: DatabaseService,
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
        const result = await this.database.withTransaction(async (session) => {
          const [created] = await OrderModel.create(
            [
              {
                orderNumber: generateOrderNumber(),
                customerId,
                pickupAddress: dto.pickupAddress,
                pickupLatitude: dto.pickupLatitude ?? null,
                pickupLongitude: dto.pickupLongitude ?? null,
                deliveryAddress: dto.deliveryAddress,
                deliveryLatitude: dto.deliveryLatitude ?? null,
                deliveryLongitude: dto.deliveryLongitude ?? null,
                packageDescription: dto.packageDescription,
                deliveryInstructions: dto.deliveryInstructions ?? null,
                deliveryFee: this.defaultDeliveryFee,
                currency: this.defaultCurrency,
                status: OrderStatus.PENDING_PAYMENT,
              },
            ],
            { session },
          );

          const order = toOrderView(created.toObject() as unknown as OrderDoc);
          const notificationId = await this.notifications.createInTransaction(
            {
              userId: customerId,
              type: 'ORDER_CREATED',
              title: 'Order created',
              message: `Your order ${order.orderNumber} has been received and is awaiting payment.`,
            },
            session,
          );

          return { order, notificationId };
        });

        void this.notifications.enqueue([result.notificationId]);

        return result.order;
      } catch (error) {
        if (!isDuplicateKeyError(error) || attempt === 4) {
          throw error;
        }
      }
    }

    throw new ConflictException('Could not generate a unique order number');
  }

  async list(user: AuthenticatedUser, query: ListOrdersQueryDto) {
    const where: Record<string, unknown> = {};

    if (user.role === UserRole.CUSTOMER) {
      where.customerId = user.id;
    } else if (user.role === UserRole.RIDER) {
      const orderIds = await DeliveryModel.find({ riderId: user.id }).distinct(
        'orderId',
      );
      where._id = { $in: orderIds };
    }

    if (query.status) {
      where.status = query.status;
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      OrderModel.find(where)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate(orderPopulate)
        .lean(),
      OrderModel.countDocuments(where),
    ]);

    return {
      data: (data as unknown as OrderDoc[]).map(toOrderView),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getById(user: AuthenticatedUser, id: string): Promise<OrderView> {
    const order = (await OrderModel.findById(id)
      .populate(orderPopulate)
      .lean()) as unknown as OrderDoc | null;

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    this.assertCanView(user, order.customerId, order.delivery?.riderId);

    return toOrderView(order);
  }

  async cancel(user: AuthenticatedUser, id: string): Promise<OrderView> {
    const order = (await OrderModel.findById(id)
      .select('_id customerId status')
      .lean()) as unknown as Pick<
      OrderDoc,
      '_id' | 'customerId' | 'status'
    > | null;

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

    const result = await OrderModel.updateOne(
      { _id: id, status: OrderStatus.PENDING_PAYMENT },
      { $set: { status: OrderStatus.CANCELLED } },
    );

    if (result.modifiedCount !== 1) {
      throw new ConflictException(
        'Only orders pending payment can be cancelled',
      );
    }

    return this.getById(user, id);
  }

  async getHistory(user: AuthenticatedUser, id: string) {
    const order = (await OrderModel.findById(id)
      .populate(orderHistoryPopulate)
      .lean()) as unknown as OrderDoc | null;

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    this.assertCanView(user, order.customerId, order.delivery?.riderId);

    const history = toOrderHistoryView(order);

    return {
      order: {
        id: history.id,
        orderNumber: history.orderNumber,
        status: history.status,
        createdAt: history.createdAt,
        updatedAt: history.updatedAt,
      },
      delivery: history.delivery
        ? {
            id: history.delivery.id,
            status: history.delivery.status,
            createdAt: history.delivery.createdAt,
            updatedAt: history.delivery.updatedAt,
          }
        : null,
      deliveryHistory: history.delivery?.statusHistory ?? [],
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
