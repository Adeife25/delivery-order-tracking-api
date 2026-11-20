import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '../database/enums';
import {
  DeliveryLocationModel,
  DeliveryStatusHistoryModel,
  DeliveryModel,
} from '../database/models';
import { deliveryPopulate } from '../database/populate';
import {
  DeliveryDoc,
  DeliveryLocationDoc,
  DeliveryStatusHistoryDoc,
  toDeliveryView,
  toTrackingLocation,
  toTrackingStatusHistory,
  TrackingLocation,
  TrackingStatusHistory,
} from '../database/views';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { DeliveryView, deliverySelect } from '../deliveries/deliveries.select';
import { SubmitLocationDto } from './dto/submit-location.dto';
import { TRACKABLE_DELIVERY_STATUSES } from './tracking-status';
import { TrackingGateway } from './tracking.gateway';

export { deliverySelect };
export type {
  TrackingLocation,
  TrackingStatusHistory,
} from '../database/views';

export interface TrackingView {
  delivery: DeliveryView;
  latestLocation: TrackingLocation | null;
  locations: TrackingLocation[];
  statusHistory: TrackingStatusHistory[];
}

const LOCATION_FIELDS = '_id deliveryId latitude longitude recordedAt';
const STATUS_HISTORY_FIELDS =
  '_id previousStatus newStatus changedById createdAt';

@Injectable()
export class TrackingService {
  constructor(private readonly gateway: TrackingGateway) {}

  async submitLocation(
    user: AuthenticatedUser,
    deliveryId: string,
    dto: SubmitLocationDto,
  ): Promise<TrackingLocation> {
    const delivery = (await DeliveryModel.findById(deliveryId)
      .select('_id riderId status')
      .lean()) as unknown as Pick<
      DeliveryDoc,
      '_id' | 'riderId' | 'status'
    > | null;

    if (!delivery || delivery.riderId !== user.id) {
      throw new NotFoundException('Delivery not found');
    }

    if (!TRACKABLE_DELIVERY_STATUSES.includes(delivery.status)) {
      throw new ConflictException(
        `Location updates are not allowed while delivery is ${delivery.status}`,
      );
    }

    const [created] = await DeliveryLocationModel.create([
      {
        deliveryId,
        latitude: dto.latitude,
        longitude: dto.longitude,
      },
    ]);

    const location = toTrackingLocation({
      _id: created._id.toString(),
      deliveryId,
      latitude: dto.latitude,
      longitude: dto.longitude,
      recordedAt: created.get('recordedAt') as Date,
    } as DeliveryLocationDoc);

    this.gateway.emitLocationUpdated(deliveryId, delivery.status, location);

    return location;
  }

  async getTracking(
    user: AuthenticatedUser,
    deliveryId: string,
  ): Promise<TrackingView> {
    const delivery = (await DeliveryModel.findById(deliveryId)
      .populate(deliveryPopulate)
      .lean()) as unknown as DeliveryDoc | null;

    if (!delivery) {
      throw new NotFoundException('Delivery not found');
    }

    this.assertCanView(
      user,
      delivery.riderId,
      delivery.order?.customerId ?? '',
    );

    const [locations, statusHistory] = await Promise.all([
      DeliveryLocationModel.find({ deliveryId })
        .sort({ recordedAt: -1 })
        .limit(50)
        .select(LOCATION_FIELDS)
        .lean(),
      DeliveryStatusHistoryModel.find({ deliveryId })
        .sort({ createdAt: -1 })
        .limit(50)
        .select(STATUS_HISTORY_FIELDS)
        .lean(),
    ]);

    const mappedLocations = (locations as unknown as DeliveryLocationDoc[]).map(
      toTrackingLocation,
    );
    const mappedHistory = (
      statusHistory as unknown as DeliveryStatusHistoryDoc[]
    ).map(toTrackingStatusHistory);

    return {
      delivery: toDeliveryView(delivery),
      latestLocation: mappedLocations[0] ?? null,
      locations: [...mappedLocations].reverse(),
      statusHistory: [...mappedHistory].reverse(),
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
