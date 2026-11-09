import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DeliveryStatus,
  OrderStatus,
  PaymentStatus,
  Prisma,
  UserRole,
} from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { orderSelect } from '../orders/orders.select';
import { paymentSelect } from '../payments/payments.select';
import { PrismaService } from '../prisma/prisma.service';
import { publicUserSelect } from '../users/users.select';
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

const riderDeliveryMetricSelect = {
  status: true,
  assignedAt: true,
  acceptedAt: true,
  pickedUpAt: true,
  deliveredAt: true,
} satisfies Prisma.DeliverySelect;

const riderRecentDeliverySelect = {
  id: true,
  status: true,
  assignedAt: true,
  acceptedAt: true,
  pickedUpAt: true,
  deliveredAt: true,
  failureReason: true,
  createdAt: true,
  order: {
    select: {
      id: true,
      orderNumber: true,
      pickupAddress: true,
      deliveryAddress: true,
      deliveryFee: true,
      currency: true,
      status: true,
    },
  },
} satisfies Prisma.DeliverySelect;

type RiderDeliveryMetric = Prisma.DeliveryGetPayload<{
  select: typeof riderDeliveryMetricSelect;
}>;

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
  groups: Array<{ status: T; _count: { _all: number } }>,
  status: T,
): number {
  return groups.find((group) => group.status === status)?._count._all ?? 0;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listRiders(query: ListRidersQueryDto) {
    const where: Prisma.UserWhereInput = { role: UserRole.RIDER };

    if (query.isActive !== undefined) {
      where.isActive = query.isActive;
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: publicUserSelect,
      }),
      this.prisma.user.count({ where }),
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

  async listCustomers(query: ListCustomersQueryDto) {
    const where: Prisma.UserWhereInput = { role: UserRole.CUSTOMER };

    if (query.isActive !== undefined) {
      where.isActive = query.isActive;
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: publicUserSelect,
      }),
      this.prisma.user.count({ where }),
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

  async updateUserStatus(
    admin: AuthenticatedUser,
    userId: string,
    isActive: boolean,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, isActive: true },
    });

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
      const activeDeliveries = await this.prisma.delivery.count({
        where: {
          riderId: userId,
          status: { in: ACTIVE_DELIVERY_STATUSES },
        },
      });

      if (activeDeliveries > 0) {
        throw new ConflictException(
          'Rider has active deliveries and cannot be deactivated',
        );
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.user.update({
        where: { id: userId },
        data: { isActive },
        select: publicUserSelect,
      });

      if (!isActive) {
        await tx.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      return result;
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
    const where: Prisma.OrderWhereInput = {};

    if (query.status) {
      where.status = query.status;
    }

    if (query.customerId) {
      where.customerId = query.customerId;
    }

    if (query.riderId) {
      where.delivery = { is: { riderId: query.riderId } };
    }

    if (query.orderNumber) {
      where.orderNumber = {
        contains: query.orderNumber,
        mode: 'insensitive',
      };
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

  async listPayments(query: ListAdminPaymentsQueryDto) {
    const where: Prisma.PaymentWhereInput = {};

    if (query.status) {
      where.status = query.status;
    }

    if (query.orderId) {
      where.orderId = query.orderId;
    }

    if (query.customerId) {
      where.order = { customerId: query.customerId };
    }

    if (query.providerReference) {
      where.providerReference = {
        contains: query.providerReference,
        mode: 'insensitive',
      };
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: paymentSelect,
      }),
      this.prisma.payment.count({ where }),
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

  async getDashboard() {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      orderGroups,
      ordersCreatedLast7Days,
      deliveryGroups,
      deliveriesCompletedLast7Days,
      deliveriesFailedLast7Days,
      paymentGroups,
      revenueGroups,
      revenueLast7DaysGroups,
      totalRiders,
      activeRiders,
      ridersWithActiveDeliveries,
    ] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.order.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      this.prisma.delivery.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.delivery.count({
        where: {
          status: DeliveryStatus.DELIVERED,
          deliveredAt: { gte: sevenDaysAgo },
        },
      }),
      this.prisma.delivery.count({
        where: {
          status: DeliveryStatus.FAILED,
          updatedAt: { gte: sevenDaysAgo },
        },
      }),
      this.prisma.payment.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.payment.groupBy({
        by: ['currency'],
        where: { status: PaymentStatus.SUCCEEDED },
        _sum: { amount: true },
        orderBy: { currency: 'asc' },
      }),
      this.prisma.payment.groupBy({
        by: ['currency'],
        where: {
          status: PaymentStatus.SUCCEEDED,
          paidAt: { gte: sevenDaysAgo },
        },
        _sum: { amount: true },
        orderBy: { currency: 'asc' },
      }),
      this.prisma.user.count({ where: { role: UserRole.RIDER } }),
      this.prisma.user.count({
        where: { role: UserRole.RIDER, isActive: true },
      }),
      this.prisma.delivery.groupBy({
        by: ['riderId'],
        where: {
          riderId: { not: null },
          status: { in: ACTIVE_DELIVERY_STATUSES },
        },
        _count: { _all: true },
      }),
    ]);

    const totalOrders = orderGroups.reduce(
      (sum, group) => sum + group._count._all,
      0,
    );
    const totalDeliveries = deliveryGroups.reduce(
      (sum, group) => sum + group._count._all,
      0,
    );
    const totalPayments = paymentGroups.reduce(
      (sum, group) => sum + group._count._all,
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
        revenueByCurrency: revenueGroups.map((group) => ({
          currency: group.currency,
          amount: group._sum.amount?.toFixed(2) ?? '0.00',
        })),
        revenueLast7DaysByCurrency: revenueLast7DaysGroups.map((group) => ({
          currency: group.currency,
          amount: group._sum.amount?.toFixed(2) ?? '0.00',
        })),
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
    const where: Prisma.UserWhereInput = { role: UserRole.RIDER };

    if (query.isActive !== undefined) {
      where.isActive = query.isActive;
    }

    const riders = await this.prisma.user.findMany({
      where,
      orderBy: { fullName: 'asc' },
      select: publicUserSelect,
    });

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

    const riderIds = riders.map((rider) => rider.id);
    const [assignmentGroups, deliveries] = await Promise.all([
      this.prisma.deliveryAssignment.groupBy({
        by: ['riderId'],
        where: { riderId: { in: riderIds } },
        _count: { _all: true },
      }),
      this.prisma.delivery.findMany({
        where: { riderId: { in: riderIds } },
        select: { ...riderDeliveryMetricSelect, riderId: true },
      }),
    ]);

    const assignmentCounts = new Map(
      assignmentGroups.map((group) => [group.riderId, group._count._all]),
    );
    const deliveriesByRider = new Map<string, RiderDeliveryMetric[]>();

    for (const delivery of deliveries) {
      if (!delivery.riderId) {
        continue;
      }

      const entries = deliveriesByRider.get(delivery.riderId) ?? [];
      entries.push(delivery);
      deliveriesByRider.set(delivery.riderId, entries);
    }

    const data = riders.map((rider) => ({
      rider,
      metrics: calculateRiderMetrics(
        deliveriesByRider.get(rider.id) ?? [],
        assignmentCounts.get(rider.id) ?? 0,
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
    const rider = await this.prisma.user.findFirst({
      where: { id: riderId, role: UserRole.RIDER },
      select: publicUserSelect,
    });

    if (!rider) {
      throw new NotFoundException('Rider not found');
    }

    const [totalAssignments, deliveries, recentDeliveries] = await Promise.all([
      this.prisma.deliveryAssignment.count({ where: { riderId } }),
      this.prisma.delivery.findMany({
        where: { riderId },
        select: riderDeliveryMetricSelect,
      }),
      this.prisma.delivery.findMany({
        where: { riderId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: riderRecentDeliverySelect,
      }),
    ]);

    return {
      rider,
      metrics: calculateRiderMetrics(deliveries, totalAssignments),
      recentDeliveries,
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
