import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { DatabaseService } from '../database/database.service';
import { DeliveryStatus, OrderStatus, UserRole } from '../database/enums';
import {
  DeliveryAssignmentModel,
  DeliveryModel,
  DeliveryStatusHistoryModel,
  OrderModel,
  UserModel,
} from '../database/models';
import { deliveryPopulate } from '../database/populate';
import { DeliveryDoc, OrderDoc, toDeliveryView } from '../database/views';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import {
  NotificationsService,
  type CreateNotificationInput,
} from '../notifications/notifications.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import {
  ACTIVE_DELIVERY_STATUSES,
  REASSIGNABLE_DELIVERY_STATUSES,
  RIDER_FAILABLE_STATUSES,
} from './delivery-status.transitions';
import { DeliveryView } from './deliveries.select';
import { FailDeliveryDto } from './dto/fail-delivery.dto';
import { ListDeliveriesQueryDto } from './dto/list-deliveries-query.dto';

interface TransitionResult {
  deliveryId: string;
  notificationId?: string;
}

interface AssignmentResult {
  deliveryId: string;
  notificationIds: string[];
}

@Injectable()
export class DeliveriesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly notifications: NotificationsService,
    private readonly tracking: TrackingGateway,
    private readonly audit: AuditService,
  ) {}

  async listAssigned(user: AuthenticatedUser, query: ListDeliveriesQueryDto) {
    const where: Record<string, unknown> = { riderId: user.id };

    if (query.status) {
      where.status = query.status;
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      DeliveryModel.find(where)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate(deliveryPopulate)
        .lean(),
      DeliveryModel.countDocuments(where),
    ]);

    return {
      data: (data as unknown as DeliveryDoc[]).map(toDeliveryView),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getById(user: AuthenticatedUser, id: string): Promise<DeliveryView> {
    const delivery = await this.getDeliveryView(id);
    this.assertCanView(user, delivery.riderId, delivery.order.customerId);
    return delivery;
  }

  async accept(user: AuthenticatedUser, id: string): Promise<DeliveryView> {
    const result = await this.riderTransition(
      user,
      id,
      [DeliveryStatus.ASSIGNED],
      {
        nextStatus: DeliveryStatus.ACCEPTED,
        data: (now) => ({ acceptedAt: now }),
      },
    );

    return this.afterStatusChange(result);
  }

  async reject(user: AuthenticatedUser, id: string): Promise<DeliveryView> {
    const result = await this.database.withTransaction(async (session) => {
      const delivery = (await DeliveryModel.findOne({ _id: id }, null, {
        session,
      }).lean()) as unknown as DeliveryDoc | null;

      if (!delivery || delivery.riderId !== user.id) {
        throw new NotFoundException('Delivery not found');
      }

      if (delivery.status !== DeliveryStatus.ASSIGNED) {
        throw new ConflictException(
          'Only an assigned delivery can be rejected',
        );
      }

      const now = new Date();
      const result = await DeliveryModel.updateOne(
        {
          _id: id,
          riderId: user.id,
          status: DeliveryStatus.ASSIGNED,
        },
        {
          $set: {
            riderId: null,
            status: DeliveryStatus.PENDING_ASSIGNMENT,
            assignedAt: null,
            acceptedAt: null,
            pickedUpAt: null,
            deliveredAt: null,
            failureReason: null,
          },
        },
        { session },
      );

      if (result.modifiedCount !== 1) {
        throw new ConflictException(
          'Only an assigned delivery can be rejected',
        );
      }

      await DeliveryStatusHistoryModel.create(
        [
          {
            deliveryId: id,
            previousStatus: DeliveryStatus.ASSIGNED,
            newStatus: DeliveryStatus.PENDING_ASSIGNMENT,
            changedById: user.id,
          },
        ],
        { session },
      );

      await DeliveryAssignmentModel.updateMany(
        { deliveryId: id, endedAt: null },
        { $set: { endedAt: now } },
        { session },
      );

      const notificationId = await this.statusNotificationInTransaction(
        id,
        DeliveryStatus.PENDING_ASSIGNMENT,
        user.id,
        session,
      );

      return { deliveryId: id, notificationId };
    });

    return this.afterStatusChange(result);
  }

  async pickup(user: AuthenticatedUser, id: string): Promise<DeliveryView> {
    const result = await this.riderTransition(
      user,
      id,
      [DeliveryStatus.ACCEPTED],
      {
        nextStatus: DeliveryStatus.PICKED_UP,
        data: (now) => ({ pickedUpAt: now }),
      },
    );

    return this.afterStatusChange(result);
  }

  async start(user: AuthenticatedUser, id: string): Promise<DeliveryView> {
    const result = await this.riderTransition(
      user,
      id,
      [DeliveryStatus.PICKED_UP],
      {
        nextStatus: DeliveryStatus.IN_TRANSIT,
      },
    );

    return this.afterStatusChange(result);
  }

  async complete(user: AuthenticatedUser, id: string): Promise<DeliveryView> {
    const result = await this.riderTransition(
      user,
      id,
      [DeliveryStatus.IN_TRANSIT],
      {
        nextStatus: DeliveryStatus.DELIVERED,
        data: (now) => ({ deliveredAt: now }),
        endAssignments: true,
      },
    );

    return this.afterStatusChange(result);
  }

  async fail(
    user: AuthenticatedUser,
    id: string,
    dto: FailDeliveryDto,
  ): Promise<DeliveryView> {
    const result = await this.riderTransition(
      user,
      id,
      RIDER_FAILABLE_STATUSES,
      {
        nextStatus: DeliveryStatus.FAILED,
        data: () => ({ failureReason: dto.reason }),
        endAssignments: true,
      },
    );

    return this.afterStatusChange(result);
  }

  async assignRider(
    admin: AuthenticatedUser,
    orderId: string,
    riderId: string,
  ): Promise<DeliveryView> {
    const result = await this.database.withTransaction(async (session) => {
      const order = (await OrderModel.findOne({ _id: orderId }, null, {
        session,
      }).lean()) as unknown as OrderDoc | null;

      if (!order) {
        throw new NotFoundException('Order not found');
      }

      if (order.status === OrderStatus.CANCELLED) {
        throw new ConflictException('Order has been cancelled');
      }

      if (order.status !== OrderStatus.CONFIRMED) {
        throw new ConflictException(
          'Order must be confirmed before a rider can be assigned',
        );
      }

      await this.getAssignableRider(session, riderId);

      const existing = (await DeliveryModel.findOne({ orderId }, null, {
        session,
      }).lean()) as unknown as DeliveryDoc | null;

      if (existing && existing.status !== DeliveryStatus.PENDING_ASSIGNMENT) {
        throw new ConflictException('Delivery is not awaiting assignment');
      }

      await this.assertRiderAvailable(session, riderId, existing?._id);

      const now = new Date();
      let deliveryId: string;

      if (existing) {
        await DeliveryModel.updateOne(
          { _id: existing._id },
          {
            $set: {
              riderId,
              status: DeliveryStatus.ASSIGNED,
              assignedAt: now,
              acceptedAt: null,
              pickedUpAt: null,
              deliveredAt: null,
              failureReason: null,
            },
          },
          { session },
        );
        deliveryId = existing._id;
      } else {
        const [created] = await DeliveryModel.create(
          [
            {
              orderId,
              riderId,
              status: DeliveryStatus.ASSIGNED,
              assignedAt: now,
            },
          ],
          { session },
        );
        deliveryId = created._id.toString();
      }

      await DeliveryStatusHistoryModel.create(
        [
          {
            deliveryId,
            previousStatus: DeliveryStatus.PENDING_ASSIGNMENT,
            newStatus: DeliveryStatus.ASSIGNED,
            changedById: admin.id,
          },
        ],
        { session },
      );

      await DeliveryAssignmentModel.create(
        [{ deliveryId, riderId, assignedById: admin.id }],
        { session },
      );

      const notificationIds: string[] = [];
      for (const input of await this.assignmentNotificationInputs(
        orderId,
        riderId,
        session,
      )) {
        notificationIds.push(
          await this.notifications.createInTransaction(input, session),
        );
      }

      return { deliveryId, notificationIds };
    });

    const delivery = await this.afterAssignment(result);

    this.audit.record({
      action: 'DELIVERY_ASSIGNED',
      actorId: admin.id,
      targetType: 'DELIVERY',
      targetId: delivery.id,
      metadata: {
        orderId: delivery.orderId,
        riderId: delivery.riderId,
      },
    });

    return delivery;
  }

  async reassignDelivery(
    admin: AuthenticatedUser,
    deliveryId: string,
    riderId: string,
  ): Promise<DeliveryView> {
    const result = await this.database.withTransaction(async (session) => {
      const delivery = (await DeliveryModel.findOne({ _id: deliveryId }, null, {
        session,
      }).lean()) as unknown as DeliveryDoc | null;

      if (!delivery) {
        throw new NotFoundException('Delivery not found');
      }

      const order = (await OrderModel.findOne({ _id: delivery.orderId }, null, {
        session,
      }).lean()) as unknown as OrderDoc | null;

      if (order?.status === OrderStatus.CANCELLED) {
        throw new ConflictException('Order has been cancelled');
      }

      if (!REASSIGNABLE_DELIVERY_STATUSES.includes(delivery.status)) {
        throw new ConflictException(
          'Only assigned or accepted deliveries can be reassigned',
        );
      }

      if (delivery.riderId === riderId) {
        throw new ConflictException(
          'Delivery is already assigned to this rider',
        );
      }

      await this.getAssignableRider(session, riderId);
      await this.assertRiderAvailable(session, riderId, deliveryId);

      const now = new Date();

      await DeliveryAssignmentModel.updateMany(
        { deliveryId, endedAt: null },
        { $set: { endedAt: now } },
        { session },
      );

      await DeliveryModel.updateOne(
        { _id: deliveryId },
        {
          $set: {
            riderId,
            status: DeliveryStatus.ASSIGNED,
            assignedAt: now,
            acceptedAt: null,
            pickedUpAt: null,
            deliveredAt: null,
            failureReason: null,
          },
        },
        { session },
      );

      if (delivery.status !== DeliveryStatus.ASSIGNED) {
        await DeliveryStatusHistoryModel.create(
          [
            {
              deliveryId,
              previousStatus: delivery.status,
              newStatus: DeliveryStatus.ASSIGNED,
              changedById: admin.id,
            },
          ],
          { session },
        );
      }

      await DeliveryAssignmentModel.create(
        [{ deliveryId, riderId, assignedById: admin.id }],
        { session },
      );

      const notificationIds: string[] = [];
      for (const input of await this.assignmentNotificationInputs(
        delivery.orderId,
        riderId,
        session,
      )) {
        notificationIds.push(
          await this.notifications.createInTransaction(input, session),
        );
      }

      return { deliveryId, notificationIds };
    });

    const delivery = await this.afterAssignment(result);

    this.audit.record({
      action: 'DELIVERY_REASSIGNED',
      actorId: admin.id,
      targetType: 'DELIVERY',
      targetId: delivery.id,
      metadata: {
        orderId: delivery.orderId,
        riderId: delivery.riderId,
      },
    });

    return delivery;
  }

  private async riderTransition(
    user: AuthenticatedUser,
    deliveryId: string,
    allowedFrom: readonly DeliveryStatus[],
    options: {
      nextStatus: DeliveryStatus;
      data?: (now: Date) => Record<string, unknown>;
      endAssignments?: boolean;
    },
  ): Promise<TransitionResult> {
    return this.database.withTransaction(async (session) => {
      const delivery = (await DeliveryModel.findOne({ _id: deliveryId }, null, {
        session,
      }).lean()) as unknown as DeliveryDoc | null;

      if (!delivery || delivery.riderId !== user.id) {
        throw new NotFoundException('Delivery not found');
      }

      if (!allowedFrom.includes(delivery.status)) {
        throw new ConflictException(
          `Delivery cannot move from ${delivery.status} to ${options.nextStatus}`,
        );
      }

      const now = new Date();
      const result = await DeliveryModel.updateOne(
        {
          _id: deliveryId,
          riderId: user.id,
          status: delivery.status,
        },
        {
          $set: {
            status: options.nextStatus,
            ...options.data?.(now),
          },
        },
        { session },
      );

      if (result.modifiedCount !== 1) {
        throw new ConflictException(
          `Delivery cannot move from ${delivery.status} to ${options.nextStatus}`,
        );
      }

      await DeliveryStatusHistoryModel.create(
        [
          {
            deliveryId,
            previousStatus: delivery.status,
            newStatus: options.nextStatus,
            changedById: user.id,
          },
        ],
        { session },
      );

      if (options.endAssignments) {
        await DeliveryAssignmentModel.updateMany(
          { deliveryId, endedAt: null },
          { $set: { endedAt: now } },
          { session },
        );
      }

      const notificationId = await this.statusNotificationInTransaction(
        deliveryId,
        options.nextStatus,
        user.id,
        session,
      );

      return { deliveryId, notificationId };
    });
  }

  private async statusNotificationInTransaction(
    deliveryId: string,
    status: DeliveryStatus,
    changedById: string,
    session: ClientSession,
  ): Promise<string | undefined> {
    const notification = this.statusNotificationForStatus(status);
    if (!notification) {
      return undefined;
    }

    const delivery = (await DeliveryModel.findOne({ _id: deliveryId }, null, {
      session,
    }).lean()) as unknown as DeliveryDoc | null;
    const order = delivery
      ? ((await OrderModel.findOne({ _id: delivery.orderId }, null, {
          session,
        }).lean()) as unknown as OrderDoc | null)
      : null;

    if (!order) {
      return undefined;
    }

    return this.notifications.createInTransaction(
      {
        userId: order.customerId,
        ...notification,
      },
      session,
    );
  }

  private async assignmentNotificationInputs(
    orderId: string,
    riderId: string,
    session: ClientSession,
  ): Promise<CreateNotificationInput[]> {
    const order = (await OrderModel.findOne({ _id: orderId }, null, {
      session,
    }).lean()) as unknown as OrderDoc | null;
    const rider = (await UserModel.findOne({ _id: riderId }, null, {
      session,
    }).lean()) as unknown as { fullName: string } | null;

    if (!order) {
      return [];
    }

    const notifications: CreateNotificationInput[] = [];

    if (rider) {
      notifications.push({
        userId: riderId,
        type: 'DELIVERY_ASSIGNED',
        title: 'New delivery assigned',
        message: `Delivery ${order.orderNumber} from ${order.pickupAddress} to ${order.deliveryAddress} has been assigned to you.`,
      });
    }

    notifications.push({
      userId: order.customerId,
      type: 'RIDER_ASSIGNED',
      title: 'Rider assigned',
      message: `Rider ${rider?.fullName ?? riderId} has been assigned to order ${order.orderNumber}.`,
    });

    return notifications;
  }

  private statusNotificationForStatus(
    status: DeliveryStatus,
  ): Omit<CreateNotificationInput, 'userId'> | null {
    switch (status) {
      case DeliveryStatus.ACCEPTED:
        return {
          type: 'DELIVERY_ACCEPTED',
          title: 'Rider accepted delivery',
          message: 'The rider accepted your delivery.',
        };
      case DeliveryStatus.PICKED_UP:
        return {
          type: 'DELIVERY_PICKED_UP',
          title: 'Package picked up',
          message: 'The package for your delivery has been picked up.',
        };
      case DeliveryStatus.IN_TRANSIT:
        return {
          type: 'DELIVERY_IN_TRANSIT',
          title: 'Delivery in transit',
          message: 'Your delivery is now in transit.',
        };
      case DeliveryStatus.DELIVERED:
        return {
          type: 'DELIVERY_COMPLETED',
          title: 'Delivery completed',
          message: 'Your delivery has been completed.',
        };
      case DeliveryStatus.FAILED:
        return {
          type: 'DELIVERY_FAILED',
          title: 'Delivery failed',
          message: 'Your delivery has failed.',
        };
      case DeliveryStatus.PENDING_ASSIGNMENT:
        return {
          type: 'DELIVERY_REJECTED',
          title: 'Delivery awaiting reassignment',
          message:
            'The rider declined your delivery. It is awaiting reassignment.',
        };
      default:
        return null;
    }
  }

  private async getDeliveryView(id: string): Promise<DeliveryView> {
    const delivery = (await DeliveryModel.findById(id)
      .populate(deliveryPopulate)
      .lean()) as unknown as DeliveryDoc | null;

    if (!delivery) {
      throw new NotFoundException('Delivery not found');
    }

    return toDeliveryView(delivery);
  }

  private async afterAssignment(
    result: AssignmentResult,
  ): Promise<DeliveryView> {
    const delivery = await this.getDeliveryView(result.deliveryId);
    this.tracking.emitDeliveryAssigned(delivery);

    if (result.notificationIds.length > 0) {
      void this.notifications.enqueue(result.notificationIds);
    }

    return delivery;
  }

  private async afterStatusChange(
    result: TransitionResult,
  ): Promise<DeliveryView> {
    const delivery = await this.getDeliveryView(result.deliveryId);
    this.tracking.emitStatusUpdated(delivery);

    if (result.notificationId) {
      void this.notifications.enqueue([result.notificationId]);
    }

    return delivery;
  }

  private async getAssignableRider(
    session: ClientSession,
    riderId: string,
  ): Promise<void> {
    const rider = await UserModel.findOne(
      { _id: riderId, role: UserRole.RIDER, isActive: true },
      null,
      { session },
    ).lean();

    if (!rider) {
      throw new NotFoundException('Rider not found');
    }
  }

  private async assertRiderAvailable(
    session: ClientSession,
    riderId: string,
    excludedDeliveryId?: string,
  ): Promise<void> {
    const active = await DeliveryModel.findOne(
      {
        riderId,
        status: { $in: [...ACTIVE_DELIVERY_STATUSES] },
        ...(excludedDeliveryId && { _id: { $ne: excludedDeliveryId } }),
      },
      null,
      { session },
    ).lean();

    if (active) {
      throw new ConflictException('Rider already has an active delivery');
    }
  }

  private assertCanView(
    user: AuthenticatedUser,
    riderId: string | null,
    customerId: string,
  ): void {
    if (user.role === UserRole.ADMIN) {
      return;
    }

    if (riderId && riderId === user.id) {
      return;
    }

    if (customerId === user.id) {
      return;
    }

    throw new NotFoundException('Delivery not found');
  }
}
