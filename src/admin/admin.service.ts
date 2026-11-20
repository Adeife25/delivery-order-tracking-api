import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  DeliveryStatus,
  OrderStatus,
  PaymentStatus,
  UserRole,
} from '../database/enums';
import {
  DeliveryAssignmentModel,
  DeliveryModel,
  OrderModel,
  PaymentModel,
  RefreshTokenModel,
  UserModel,
} from '../database/models';
import { orderPopulate, paymentPopulate } from '../database/populate';
import {
  DeliveryDoc,
  OrderDoc,
  PaymentDoc,
  PublicUser,
  UserDoc,
  toOrderView,
  toPublicUser,
} from '../database/views';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { USER_PUBLIC_FIELDS } from '../database/populate';
import { ListAdminOrdersQueryDto } from './dto/list-admin-orders-query.dto';
import { ListAdminPaymentsQueryDto } from './dto/list-admin-payments-query.dto';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto';
import { ListRidersQueryDto } from './dto/list-riders-query.dto';
import {
  RiderPerformanceQueryDto,
  RiderPerformanceSort,
  SortOrder,
} from './dto/rider-performance-query.dto';

const ACTIVE_DELIVERY_STATUSES: DeliveryStatus[] = [
  DeliveryStatus.ASSIGNED,
  DeliveryStatus.ACCEPTED,
  DeliveryStatus.PICKED_UP,
  DeliveryStatus.IN_TRANSIT,
];

const RIDER_DELIVERY_METRIC_FIELDS =
  'status assignedAt acceptedAt pickedUpAt deliveredAt';
const RIDER_RECENT_DELIVERY_ORDER_FIELDS =
  '_id orderNumber pickupAddress deliveryAddress deliveryFee currency status';

export interface RiderDeliveryMetric {
  status: DeliveryStatus;
  assignedAt: Date | null;
  acceptedAt: Date | null;
  pickedUpAt: Date | null;
  deliveredAt: Date | null;
}

export interface RiderMetrics {
  totalAssignments: number;
  totalDeliveries: number;
  activeDeliveries: number;
  completed: number;
  failed: number;
  completionRate: number | null;
  averageAcceptanceSeconds: number | null;
  averageDeliveryMinutes: number | null;
  lastDeliveredAt: Date | null;
}

function round(value: number, decimalPlaces = 1): number {
  const factor = 10 ** decimalPlaces;
  return Math.round(value * factor) / factor;
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function calculateRiderMetrics(
  deliveries: RiderDeliveryMetric[],
  totalAssignments: number,
): RiderMetrics {
  let activeDeliveries = 0;
  let completed = 0;
  let failed = 0;
  let lastDeliveredAt: Date | null = null;
  const acceptanceDurations: number[] = [];
  const deliveryDurations: number[] = [];

  for (const delivery of deliveries) {
    if (delivery.status === DeliveryStatus.DELIVERED) {
      completed += 1;
    } else if (delivery.status === DeliveryStatus.FAILED) {
      failed += 1;
    } else if (ACTIVE_DELIVERY_STATUSES.includes(delivery.status)) {
      activeDeliveries += 1;
    }

    if (delivery.assignedAt && delivery.acceptedAt) {
      acceptanceDurations.push(
        (delivery.acceptedAt.getTime() - delivery.assignedAt.getTime()) / 1000,
      );
    }

    if (delivery.pickedUpAt && delivery.deliveredAt) {
      deliveryDurations.push(
        (delivery.deliveredAt.getTime() - delivery.pickedUpAt.getTime()) /
          60000,
      );
    }

    if (
      delivery.status === DeliveryStatus.DELIVERED &&
      delivery.deliveredAt &&
      (!lastDeliveredAt || delivery.deliveredAt > lastDeliveredAt)
    ) {
      lastDeliveredAt = delivery.deliveredAt;
    }
  }

  const finalisedDeliveries = completed + failed;

  return {
    totalAssignments,
    totalDeliveries: deliveries.length,
    activeDeliveries,
    completed,
    failed,
    completionRate:
      finalisedDeliveries === 0
        ? null
        : round((completed / finalisedDeliveries) * 100),
    averageAcceptanceSeconds: average(acceptanceDurations),
    averageDeliveryMinutes: average(deliveryDurations),
    lastDeliveredAt,
  };
}

function groupCount<T extends string>(
  groups: Array<{ status: T; count: number }>,
  status: T,
): number {
  return groups.find((group) => group.status === status)?.count ?? 0;
}

async function countByStatus<T extends string>(
  rowsPromise: Promise<Array<{ _id: T; count: number }>>,
  statuses: readonly T[],
): Promise<Array<{ status: T; count: number }>> {
  const rows = await rowsPromise;
  const counts = new Map(rows.map((row) => [row._id, row.count]));

  return statuses.map((status) => ({ status, count: counts.get(status) ?? 0 }));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sumAmounts(payments: Array<{ amount: string; currency: string }>) {
  const byCurrency = new Map<string, number>();

  for (const payment of payments) {
    const amount = Number(payment.amount);
    byCurrency.set(
      payment.currency,
      (byCurrency.get(payment.currency) ?? 0) + amount,
    );
  }

  return [...byCurrency.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => ({ currency, amount: amount.toFixed(2) }));
}

@Injectable()
export class AdminService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async listRiders(query: ListRidersQueryDto) {
    return this.listUsers(
      query.isActive,
      UserRole.RIDER,
      query.page,
      query.limit,
    );
  }

  async listCustomers(query: ListCustomersQueryDto) {
    return this.listUsers(
      query.isActive,
      UserRole.CUSTOMER,
      query.page,
      query.limit,
    );
  }

  async updateUserStatus(
    admin: AuthenticatedUser,
    userId: string,
    isActive: boolean,
  ): Promise<PublicUser> {
    const user = (await UserModel.findOne({ _id: userId })
      .select('_id role isActive')
      .lean()) as unknown as Pick<UserDoc, '_id' | 'role' | 'isActive'> | null;

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role === UserRole.ADMIN) {
      throw new BadRequestException(
        'Administrator accounts cannot be managed through this endpoint',
      );
    }

    if (admin.id === userId) {
      throw new BadRequestException(
        'Administrators cannot deactivate themselves',
      );
    }

    if (!isActive && user.role === UserRole.RIDER) {
      const activeDeliveries = await DeliveryModel.countDocuments({
        riderId: userId,
        status: { $in: ACTIVE_DELIVERY_STATUSES },
      });

      if (activeDeliveries > 0) {
        throw new ConflictException(
          'Rider has active deliveries and cannot be deactivated',
        );
      }
    }

    const updated = await this.database.withTransaction(async (session) => {
      const user = (await UserModel.findOneAndUpdate(
        { _id: userId },
        { $set: { isActive } },
        { new: true, session },
      )
        .select(USER_PUBLIC_FIELDS)
        .lean()) as unknown as UserDoc | null;

      if (!user) {
        throw new NotFoundException('User not found');
      }

      if (!isActive) {
        await RefreshTokenModel.updateMany(
          { userId, revokedAt: null },
          { $set: { revokedAt: new Date() } },
          { session },
        );
      }

      return toPublicUser(user);
    });

    if (user.isActive !== isActive) {
      this.audit.record({
        action: isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
        actorId: admin.id,
        targetType: 'USER',
        targetId: userId,
        metadata: { role: user.role },
      });
    }

    return updated;
  }

  async listOrders(query: ListAdminOrdersQueryDto) {
    const where: Record<string, unknown> = {};

    if (query.status) {
      where.status = query.status;
    }

    if (query.customerId) {
      where.customerId = query.customerId;
    }

    if (query.riderId) {
      where._id = {
        $in: await DeliveryModel.find({ riderId: query.riderId }).distinct(
          'orderId',
        ),
      };
    }

    if (query.orderNumber) {
      where.orderNumber = new RegExp(escapeRegex(query.orderNumber), 'i');
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

  async listPayments(query: ListAdminPaymentsQueryDto) {
    const where: Record<string, unknown> = {};

    if (query.status) {
      where.status = query.status;
    }

    if (query.orderId) {
      where.orderId = query.orderId;
    }

    if (query.customerId) {
      where.orderId = {
        $in: await OrderModel.find({ customerId: query.customerId }).distinct(
          '_id',
        ),
      };
    }

    if (query.providerReference) {
      where.providerReference = new RegExp(
        escapeRegex(query.providerReference),
        'i',
      );
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      PaymentModel.find(where)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate(paymentPopulate)
        .lean(),
      PaymentModel.countDocuments(where),
    ]);

    return {
      data: (data as unknown as PaymentDoc[]).map((payment) => {
        if (!payment.order) {
          throw new NotFoundException('Payment order was not found');
        }

        return {
          id: payment._id,
          orderId: payment.orderId,
          provider: payment.provider ?? null,
          providerReference: payment.providerReference ?? null,
          amount: payment.amount,
          currency: payment.currency,
          status: payment.status,
          paidAt: payment.paidAt ?? null,
          createdAt: payment.createdAt,
          updatedAt: payment.updatedAt,
          order: {
            id: payment.order._id,
            orderNumber: payment.order.orderNumber,
            customerId: payment.order.customerId,
            status: payment.order.status,
          },
        };
      }),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getDashboard() {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const statuses = {
      orders: [
        OrderStatus.PENDING_PAYMENT,
        OrderStatus.CONFIRMED,
        OrderStatus.CANCELLED,
      ],
      deliveries: [
        DeliveryStatus.PENDING_ASSIGNMENT,
        DeliveryStatus.ASSIGNED,
        DeliveryStatus.ACCEPTED,
        DeliveryStatus.PICKED_UP,
        DeliveryStatus.IN_TRANSIT,
        DeliveryStatus.DELIVERED,
        DeliveryStatus.FAILED,
        DeliveryStatus.CANCELLED,
      ],
      payments: [
        PaymentStatus.PENDING,
        PaymentStatus.SUCCEEDED,
        PaymentStatus.FAILED,
        PaymentStatus.REFUNDED,
      ],
    } as const;

    const [
      orderGroups,
      ordersCreatedLast7Days,
      deliveryGroups,
      deliveriesCompletedLast7Days,
      deliveriesFailedLast7Days,
      paymentGroups,
      succeededPayments,
      ridersWithActiveDeliveries,
      totalRiders,
      activeRiders,
    ] = await Promise.all([
      countByStatus(
        OrderModel.aggregate([
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]) as Promise<Array<{ _id: OrderStatus; count: number }>>,
        statuses.orders,
      ),
      OrderModel.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
      countByStatus(
        DeliveryModel.aggregate([
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]) as Promise<Array<{ _id: DeliveryStatus; count: number }>>,
        statuses.deliveries,
      ),
      DeliveryModel.countDocuments({
        status: DeliveryStatus.DELIVERED,
        deliveredAt: { $gte: sevenDaysAgo },
      }),
      DeliveryModel.countDocuments({
        status: DeliveryStatus.FAILED,
        updatedAt: { $gte: sevenDaysAgo },
      }),
      countByStatus(
        PaymentModel.aggregate([
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]) as Promise<Array<{ _id: PaymentStatus; count: number }>>,
        statuses.payments,
      ),
      PaymentModel.find({ status: PaymentStatus.SUCCEEDED })
        .select('amount currency paidAt')
        .lean(),
      DeliveryModel.distinct('riderId', {
        riderId: { $ne: null },
        status: { $in: ACTIVE_DELIVERY_STATUSES },
      }),
      UserModel.countDocuments({ role: UserRole.RIDER }),
      UserModel.countDocuments({ role: UserRole.RIDER, isActive: true }),
    ]);

    const payments = succeededPayments as unknown as PaymentDoc[];
    const totalOrders = orderGroups.reduce(
      (sum, group) => sum + group.count,
      0,
    );
    const totalDeliveries = deliveryGroups.reduce(
      (sum, group) => sum + group.count,
      0,
    );
    const totalPayments = paymentGroups.reduce(
      (sum, group) => sum + group.count,
      0,
    );
    const activeDeliveryCount = ACTIVE_DELIVERY_STATUSES.reduce(
      (sum, status) => sum + groupCount(deliveryGroups, status),
      0,
    );

    return {
      generatedAt: now,
      orders: {
        total: totalOrders,
        pendingPayment: groupCount(orderGroups, OrderStatus.PENDING_PAYMENT),
        confirmed: groupCount(orderGroups, OrderStatus.CONFIRMED),
        cancelled: groupCount(orderGroups, OrderStatus.CANCELLED),
        createdLast7Days: ordersCreatedLast7Days,
      },
      deliveries: {
        total: totalDeliveries,
        pendingAssignment: groupCount(
          deliveryGroups,
          DeliveryStatus.PENDING_ASSIGNMENT,
        ),
        assigned: groupCount(deliveryGroups, DeliveryStatus.ASSIGNED),
        accepted: groupCount(deliveryGroups, DeliveryStatus.ACCEPTED),
        pickedUp: groupCount(deliveryGroups, DeliveryStatus.PICKED_UP),
        inTransit: groupCount(deliveryGroups, DeliveryStatus.IN_TRANSIT),
        delivered: groupCount(deliveryGroups, DeliveryStatus.DELIVERED),
        failed: groupCount(deliveryGroups, DeliveryStatus.FAILED),
        cancelled: groupCount(deliveryGroups, DeliveryStatus.CANCELLED),
        active: activeDeliveryCount,
        deliveredLast7Days: deliveriesCompletedLast7Days,
        failedLast7Days: deliveriesFailedLast7Days,
      },
      payments: {
        total: totalPayments,
        pending: groupCount(paymentGroups, PaymentStatus.PENDING),
        succeeded: groupCount(paymentGroups, PaymentStatus.SUCCEEDED),
        failed: groupCount(paymentGroups, PaymentStatus.FAILED),
        refunded: groupCount(paymentGroups, PaymentStatus.REFUNDED),
        revenueByCurrency: sumAmounts(payments),
        revenueLast7DaysByCurrency: sumAmounts(
          payments.filter(
            (payment) => payment.paidAt && payment.paidAt >= sevenDaysAgo,
          ),
        ),
      },
      riders: {
        total: totalRiders,
        active: activeRiders,
        inactive: totalRiders - activeRiders,
        withActiveDeliveries: ridersWithActiveDeliveries.length,
      },
    };
  }

  async listRiderPerformance(query: RiderPerformanceQueryDto) {
    const where: Record<string, unknown> = { role: UserRole.RIDER };

    if (query.isActive !== undefined) {
      where.isActive = query.isActive;
    }

    const riders = (await UserModel.find(where)
      .sort({ fullName: 1 })
      .select(USER_PUBLIC_FIELDS)
      .lean()) as unknown as UserDoc[];

    if (riders.length === 0) {
      return {
        data: [],
        meta: {
          page: query.page ?? 1,
          limit: query.limit ?? 20,
          total: 0,
          totalPages: 0,
        },
      };
    }

    const riderIds = riders.map((rider) => rider._id);
    const [assignmentGroups, deliveries] = await Promise.all([
      DeliveryAssignmentModel.aggregate([
        { $match: { riderId: { $in: riderIds } } },
        { $group: { _id: '$riderId', count: { $sum: 1 } } },
      ]) as Promise<Array<{ _id: string; count: number }>>,
      DeliveryModel.find({ riderId: { $in: riderIds } })
        .select(`${RIDER_DELIVERY_METRIC_FIELDS} riderId`)
        .lean(),
    ]);

    const assignmentCounts = new Map(
      assignmentGroups.map((group) => [group._id, group.count]),
    );
    const deliveriesByRider = new Map<string, RiderDeliveryMetric[]>();

    for (const delivery of deliveries as unknown as Array<
      RiderDeliveryMetric & { riderId: string | null }
    >) {
      if (!delivery.riderId) {
        continue;
      }

      const entries = deliveriesByRider.get(delivery.riderId) ?? [];
      entries.push(delivery);
      deliveriesByRider.set(delivery.riderId, entries);
    }

    const data = riders.map((rider) => ({
      rider: toPublicUser(rider),
      metrics: calculateRiderMetrics(
        deliveriesByRider.get(rider._id) ?? [],
        assignmentCounts.get(rider._id) ?? 0,
      ),
    }));

    data.sort((left, right) => {
      const difference =
        this.performanceSortValue(left.metrics, query.sort) -
        this.performanceSortValue(right.metrics, query.sort);

      if (difference !== 0) {
        return query.order === SortOrder.ASC ? difference : -difference;
      }

      return (
        left.rider.fullName.localeCompare(right.rider.fullName) ||
        left.rider.id.localeCompare(right.rider.id)
      );
    });

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const total = data.length;
    const skip = (page - 1) * limit;

    return {
      data: data.slice(skip, skip + limit),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getRiderPerformance(riderId: string) {
    const rider = (await UserModel.findOne({
      _id: riderId,
      role: UserRole.RIDER,
    })
      .select(USER_PUBLIC_FIELDS)
      .lean()) as unknown as UserDoc | null;

    if (!rider) {
      throw new NotFoundException('Rider not found');
    }

    const [totalAssignments, deliveries, recentDeliveries] = await Promise.all([
      DeliveryAssignmentModel.countDocuments({ riderId }),
      DeliveryModel.find({ riderId })
        .select(RIDER_DELIVERY_METRIC_FIELDS)
        .lean(),
      DeliveryModel.find({ riderId })
        .sort({ createdAt: -1 })
        .limit(10)
        .populate('order', RIDER_RECENT_DELIVERY_ORDER_FIELDS)
        .lean(),
    ]);

    return {
      rider: toPublicUser(rider),
      metrics: calculateRiderMetrics(
        deliveries as unknown as RiderDeliveryMetric[],
        totalAssignments,
      ),
      recentDeliveries: (recentDeliveries as unknown as DeliveryDoc[]).map(
        (delivery) => ({
          id: delivery._id,
          status: delivery.status,
          assignedAt: delivery.assignedAt,
          acceptedAt: delivery.acceptedAt,
          pickedUpAt: delivery.pickedUpAt,
          deliveredAt: delivery.deliveredAt,
          failureReason: delivery.failureReason,
          createdAt: delivery.createdAt,
          order: delivery.order
            ? {
                id: delivery.order._id,
                orderNumber: delivery.order.orderNumber,
                pickupAddress: delivery.order.pickupAddress,
                deliveryAddress: delivery.order.deliveryAddress,
                deliveryFee: delivery.order.deliveryFee,
                currency: delivery.order.currency,
                status: delivery.order.status,
              }
            : null,
        }),
      ),
    };
  }

  private async listUsers(
    isActive: boolean | undefined,
    role: UserRole,
    page = 1,
    limit = 20,
  ) {
    const where: Record<string, unknown> = { role };

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      UserModel.find(where)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select(USER_PUBLIC_FIELDS)
        .lean(),
      UserModel.countDocuments(where),
    ]);

    return {
      data: (data as unknown as UserDoc[]).map(toPublicUser),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  private performanceSortValue(
    metrics: RiderMetrics,
    sort: RiderPerformanceSort,
  ): number {
    switch (sort) {
      case RiderPerformanceSort.TOTAL_ASSIGNMENTS:
        return metrics.totalAssignments;
      case RiderPerformanceSort.COMPLETED:
        return metrics.completed;
      case RiderPerformanceSort.FAILED:
        return metrics.failed;
      case RiderPerformanceSort.COMPLETION_RATE:
        return metrics.completionRate ?? -1;
      case RiderPerformanceSort.AVERAGE_DELIVERY_MINUTES:
        return metrics.averageDeliveryMinutes ?? -1;
      case RiderPerformanceSort.LAST_DELIVERED_AT:
        return metrics.lastDeliveredAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    }
  }
}
