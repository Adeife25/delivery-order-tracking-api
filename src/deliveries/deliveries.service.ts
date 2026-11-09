import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DeliveryStatus,
  OrderStatus,
  Prisma,
  UserRole,
} from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import {
  NotificationsService,
  type CreateNotificationInput,
} from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import {
  ACTIVE_DELIVERY_STATUSES,
  REASSIGNABLE_DELIVERY_STATUSES,
  RIDER_FAILABLE_STATUSES,
} from './delivery-status.transitions';
import { DeliveryView, deliverySelect } from './deliveries.select';
import { FailDeliveryDto } from './dto/fail-delivery.dto';
import { ListDeliveriesQueryDto } from './dto/list-deliveries-query.dto';

type TransactionClient = Prisma.TransactionClient;

interface TransitionResult {
  delivery: DeliveryView;
  notificationId?: string;
}

interface AssignmentResult {
  delivery: DeliveryView;
  notificationIds: string[];
}

function isRetryableTransactionError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2034'
  );
}

@Injectable()
export class DeliveriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly tracking: TrackingGateway,
    private readonly audit: AuditService,
  ) {}

  async listAssigned(user: AuthenticatedUser, query: ListDeliveriesQueryDto) {
    const where: Prisma.DeliveryWhereInput = { riderId: user.id };

    if (query.status) {
      where.status = query.status;
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.delivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: deliverySelect,
      }),
      this.prisma.delivery.count({ where }),
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

  async getById(user: AuthenticatedUser, id: string): Promise<DeliveryView> {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id },
      select: deliverySelect,
    });

    if (!delivery) {
      throw new NotFoundException('Delivery not found');
    }

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
    const result = await this.prisma.$transaction(async (tx) => {
      const delivery = await tx.delivery.findUnique({
        where: { id },
        select: { id: true, riderId: true, status: true },
      });

      if (!delivery || delivery.riderId !== user.id) {
        throw new NotFoundException('Delivery not found');
      }

      if (delivery.status !== DeliveryStatus.ASSIGNED) {
        throw new ConflictException(
          'Only an assigned delivery can be rejected',
        );
      }

      const now = new Date();
      const result = await tx.delivery.updateMany({
        where: {
          id,
          riderId: user.id,
          status: DeliveryStatus.ASSIGNED,
        },
        data: {
          riderId: null,
          status: DeliveryStatus.PENDING_ASSIGNMENT,
          assignedAt: null,
          acceptedAt: null,
          pickedUpAt: null,
          deliveredAt: null,
          failureReason: null,
        },
      });

      if (result.count !== 1) {
        throw new ConflictException(
          'Only an assigned delivery can be rejected',
        );
      }

      const updated = await tx.delivery.findUniqueOrThrow({
        where: { id },
        select: deliverySelect,
      });

      await tx.deliveryStatusHistory.create({
        data: {
          deliveryId: id,
          previousStatus: DeliveryStatus.ASSIGNED,
          newStatus: DeliveryStatus.PENDING_ASSIGNMENT,
          changedById: user.id,
        },
      });

      await tx.deliveryAssignment.updateMany({
        where: { deliveryId: id, endedAt: null },
        data: { endedAt: now },
      });

      const notification = this.statusNotification(updated);
      const notificationId = notification
        ? await this.notifications.createInTransaction(tx, {
            userId: updated.order.customerId,
            ...notification,
          })
        : undefined;

      return { delivery: updated, notificationId };
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
    const result = await this.serializable(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true },
      });

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

      await this.getAssignableRider(tx, riderId);

      const existing = await tx.delivery.findUnique({
        where: { orderId },
        select: { id: true, riderId: true, status: true },
      });

      if (existing && existing.status !== DeliveryStatus.PENDING_ASSIGNMENT) {
        throw new ConflictException('Delivery is not awaiting assignment');
      }

      await this.assertRiderAvailable(tx, riderId, existing?.id);

      const now = new Date();
      let delivery: DeliveryView;

      if (existing) {
        delivery = await tx.delivery.update({
          where: { id: existing.id },
          data: {
            riderId,
            status: DeliveryStatus.ASSIGNED,
            assignedAt: now,
            acceptedAt: null,
            pickedUpAt: null,
            deliveredAt: null,
            failureReason: null,
          },
          select: deliverySelect,
        });
      } else {
        delivery = await tx.delivery.create({
          data: {
            orderId,
            riderId,
            status: DeliveryStatus.ASSIGNED,
            assignedAt: now,
          },
          select: deliverySelect,
        });
      }

      await tx.deliveryStatusHistory.create({
        data: {
          deliveryId: delivery.id,
          previousStatus: DeliveryStatus.PENDING_ASSIGNMENT,
          newStatus: DeliveryStatus.ASSIGNED,
          changedById: admin.id,
        },
      });

      await tx.deliveryAssignment.create({
        data: {
          deliveryId: delivery.id,
          riderId,
          assignedById: admin.id,
        },
      });

      const notificationIds: string[] = [];
      for (const input of this.assignmentNotifications(delivery)) {
        notificationIds.push(
          await this.notifications.createInTransaction(tx, input),
        );
      }

      return { delivery, notificationIds };
    });

    const delivery = this.afterAssignment(result);

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
    const result = await this.serializable(async (tx) => {
      const delivery = await tx.delivery.findUnique({
        where: { id: deliveryId },
        select: {
          id: true,
          riderId: true,
          status: true,
          order: { select: { status: true } },
        },
      });

      if (!delivery) {
        throw new NotFoundException('Delivery not found');
      }

      if (delivery.order.status === OrderStatus.CANCELLED) {
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

      await this.getAssignableRider(tx, riderId);
      await this.assertRiderAvailable(tx, riderId, delivery.id);

      const now = new Date();

      await tx.deliveryAssignment.updateMany({
        where: { deliveryId, endedAt: null },
        data: { endedAt: now },
      });

      const updated = await tx.delivery.update({
        where: { id: deliveryId },
        data: {
          riderId,
          status: DeliveryStatus.ASSIGNED,
          assignedAt: now,
          acceptedAt: null,
          pickedUpAt: null,
          deliveredAt: null,
          failureReason: null,
        },
        select: deliverySelect,
      });

      if (delivery.status !== DeliveryStatus.ASSIGNED) {
        await tx.deliveryStatusHistory.create({
          data: {
            deliveryId,
            previousStatus: delivery.status,
            newStatus: DeliveryStatus.ASSIGNED,
            changedById: admin.id,
          },
        });
      }

      await tx.deliveryAssignment.create({
        data: {
          deliveryId,
          riderId,
          assignedById: admin.id,
        },
      });

      const notificationIds: string[] = [];
      for (const input of this.assignmentNotifications(updated)) {
        notificationIds.push(
          await this.notifications.createInTransaction(tx, input),
        );
      }

      return { delivery: updated, notificationIds };
    });

    const delivery = this.afterAssignment(result);

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
      data?: (now: Date) => Prisma.DeliveryUpdateInput;
      endAssignments?: boolean;
    },
  ): Promise<TransitionResult> {
    return this.prisma.$transaction(async (tx) => {
      const delivery = await tx.delivery.findUnique({
        where: { id: deliveryId },
        select: { id: true, riderId: true, status: true },
      });

      if (!delivery || delivery.riderId !== user.id) {
        throw new NotFoundException('Delivery not found');
      }

      if (!allowedFrom.includes(delivery.status)) {
        throw new ConflictException(
          `Delivery cannot move from ${delivery.status} to ${options.nextStatus}`,
        );
      }

      const now = new Date();
      const result = await tx.delivery.updateMany({
        where: {
          id: deliveryId,
          riderId: user.id,
          status: delivery.status,
        },
        data: {
          status: options.nextStatus,
          ...options.data?.(now),
        },
      });

      if (result.count !== 1) {
        throw new ConflictException(
          `Delivery cannot move from ${delivery.status} to ${options.nextStatus}`,
        );
      }

      const updated = await tx.delivery.findUniqueOrThrow({
        where: { id: deliveryId },
        select: deliverySelect,
      });

      await tx.deliveryStatusHistory.create({
        data: {
          deliveryId,
          previousStatus: delivery.status,
          newStatus: options.nextStatus,
          changedById: user.id,
        },
      });

      if (options.endAssignments) {
        await tx.deliveryAssignment.updateMany({
          where: { deliveryId, endedAt: null },
          data: { endedAt: now },
        });
      }

      const notification = this.statusNotification(updated);
      const notificationId = notification
        ? await this.notifications.createInTransaction(tx, {
            userId: updated.order.customerId,
            ...notification,
          })
        : undefined;

      return { delivery: updated, notificationId };
    });
  }

  private assignmentNotifications(
    delivery: DeliveryView,
  ): CreateNotificationInput[] {
    const notifications: CreateNotificationInput[] = [];

    if (delivery.riderId) {
      notifications.push({
        userId: delivery.riderId,
        type: 'DELIVERY_ASSIGNED',
        title: 'New delivery assigned',
        message: `Delivery ${delivery.order.orderNumber} from ${delivery.order.pickupAddress} to ${delivery.order.deliveryAddress} has been assigned to you.`,
      });
    }

    notifications.push({
      userId: delivery.order.customerId,
      type: 'RIDER_ASSIGNED',
      title: 'Rider assigned',
      message: `Rider ${delivery.rider?.fullName ?? delivery.riderId ?? 'unknown'} has been assigned to order ${delivery.order.orderNumber}.`,
    });

    return notifications;
  }

  private afterAssignment(result: AssignmentResult): DeliveryView {
    this.tracking.emitDeliveryAssigned(result.delivery);

    if (result.notificationIds.length > 0) {
      void this.notifications.enqueue(result.notificationIds);
    }

    return result.delivery;
  }

  private afterStatusChange(result: TransitionResult): DeliveryView {
    this.tracking.emitStatusUpdated(result.delivery);

    if (result.notificationId) {
      void this.notifications.enqueue([result.notificationId]);
    }

    return result.delivery;
  }

  private statusNotification(
    delivery: DeliveryView,
  ): Omit<CreateNotificationInput, 'userId'> | null {
    const orderNumber = delivery.order.orderNumber;

    switch (delivery.status) {
      case DeliveryStatus.ACCEPTED:
        return {
          type: 'DELIVERY_ACCEPTED',
          title: 'Rider accepted delivery',
          message: `The rider accepted delivery ${orderNumber}.`,
        };
      case DeliveryStatus.PICKED_UP:
        return {
          type: 'DELIVERY_PICKED_UP',
          title: 'Package picked up',
          message: `The package for delivery ${orderNumber} has been picked up.`,
        };
      case DeliveryStatus.IN_TRANSIT:
        return {
          type: 'DELIVERY_IN_TRANSIT',
          title: 'Delivery in transit',
          message: `Delivery ${orderNumber} is now in transit.`,
        };
      case DeliveryStatus.DELIVERED:
        return {
          type: 'DELIVERY_COMPLETED',
          title: 'Delivery completed',
          message: `Delivery ${orderNumber} has been completed.`,
        };
      case DeliveryStatus.FAILED:
        return {
          type: 'DELIVERY_FAILED',
          title: 'Delivery failed',
          message: `Delivery ${orderNumber} failed${delivery.failureReason ? `: ${delivery.failureReason}` : ''}.`,
        };
      case DeliveryStatus.PENDING_ASSIGNMENT:
        return {
          type: 'DELIVERY_REJECTED',
          title: 'Delivery awaiting reassignment',
          message: `The rider declined delivery ${orderNumber}. It is awaiting reassignment.`,
        };
      default:
        return null;
    }
  }

  private async getAssignableRider(
    tx: TransactionClient,
    riderId: string,
  ): Promise<void> {
    const rider = await tx.user.findFirst({
      where: {
        id: riderId,
        role: UserRole.RIDER,
        isActive: true,
      },
      select: { id: true },
    });

    if (!rider) {
      throw new NotFoundException('Rider not found');
    }
  }

  private async assertRiderAvailable(
    tx: TransactionClient,
    riderId: string,
    excludedDeliveryId?: string,
  ): Promise<void> {
    const active = await tx.delivery.findFirst({
      where: {
        riderId,
        status: { in: [...ACTIVE_DELIVERY_STATUSES] },
        ...(excludedDeliveryId && { id: { not: excludedDeliveryId } }),
      },
      select: { id: true },
    });

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

  private async serializable<T>(
    operation: (tx: TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (!isRetryableTransactionError(error) || attempt === 2) {
          throw error;
        }
      }
    }

    throw new ConflictException('Could not complete the operation');
  }
}
