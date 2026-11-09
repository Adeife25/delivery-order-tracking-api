import { DeliveryStatus } from '../generated/prisma/enums';

export const TRACKABLE_DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  DeliveryStatus.ACCEPTED,
  DeliveryStatus.PICKED_UP,
  DeliveryStatus.IN_TRANSIT,
];
