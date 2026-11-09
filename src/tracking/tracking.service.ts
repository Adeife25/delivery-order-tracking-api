import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '../generated/prisma/client';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { PrismaService } from '../prisma/prisma.service';
import { DeliveryView, deliverySelect } from '../deliveries/deliveries.select';
import { SubmitLocationDto } from './dto/submit-location.dto';
import { TRACKABLE_DELIVERY_STATUSES } from './tracking-status';
import { TrackingGateway } from './tracking.gateway';

export const trackingLocationSelect = {
  id: true,
  deliveryId: true,
  latitude: true,
  longitude: true,
  recordedAt: true,
} satisfies Prisma.DeliveryLocationSelect;

export type TrackingLocation = Prisma.DeliveryLocationGetPayload<{
  select: typeof trackingLocationSelect;
}>;

export const trackingStatusHistorySelect = {
  id: true,
  previousStatus: true,
  newStatus: true,
  changedById: true,
  createdAt: true,
} satisfies Prisma.DeliveryStatusHistorySelect;

export type TrackingStatusHistory = Prisma.DeliveryStatusHistoryGetPayload<{
  select: typeof trackingStatusHistorySelect;
}>;

export interface TrackingView {
  delivery: DeliveryView;
  latestLocation: TrackingLocation | null;
  locations: TrackingLocation[];
  statusHistory: TrackingStatusHistory[];
}

@Injectable()
export class TrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: TrackingGateway,
  ) {}

  async submitLocation(
    user: AuthenticatedUser,
    deliveryId: string,
    dto: SubmitLocationDto,
  ): Promise<TrackingLocation> {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: { id: true, riderId: true, status: true },
    });

    if (!delivery || delivery.riderId !== user.id) {
      throw new NotFoundException('Delivery not found');
    }

    if (!TRACKABLE_DELIVERY_STATUSES.includes(delivery.status)) {
      throw new ConflictException(
        `Location updates are not allowed while delivery is ${delivery.status}`,
      );
    }

    const location = await this.prisma.deliveryLocation.create({
      data: {
        deliveryId,
        latitude: dto.latitude,
        longitude: dto.longitude,
      },
      select: trackingLocationSelect,
    });

    this.gateway.emitLocationUpdated(deliveryId, delivery.status, location);

    return location;
  }

  async getTracking(
    user: AuthenticatedUser,
    deliveryId: string,
  ): Promise<TrackingView> {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: deliverySelect,
    });

    if (!delivery) {
      throw new NotFoundException('Delivery not found');
    }

    this.assertCanView(user, delivery.riderId, delivery.order.customerId);

    const [locations, statusHistory] = await Promise.all([
      this.prisma.deliveryLocation.findMany({
        where: { deliveryId },
        orderBy: { recordedAt: 'desc' },
        take: 50,
        select: trackingLocationSelect,
      }),
      this.prisma.deliveryStatusHistory.findMany({
        where: { deliveryId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: trackingStatusHistorySelect,
      }),
    ]);

    return {
      delivery,
      latestLocation: locations[0] ?? null,
      locations: [...locations].reverse(),
      statusHistory: [...statusHistory].reverse(),
    };
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
