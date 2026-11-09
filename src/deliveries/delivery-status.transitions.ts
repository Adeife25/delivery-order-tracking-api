import { DeliveryStatus } from '../generated/prisma/enums';

export const DELIVERY_STATUS_TRANSITIONS: Record<
  DeliveryStatus,
  readonly DeliveryStatus[]
> = {
  [DeliveryStatus.PENDING_ASSIGNMENT]: [DeliveryStatus.ASSIGNED],
  [DeliveryStatus.ASSIGNED]: [
    DeliveryStatus.ACCEPTED,
    DeliveryStatus.PENDING_ASSIGNMENT,
    DeliveryStatus.FAILED,
  ],
  [DeliveryStatus.ACCEPTED]: [DeliveryStatus.PICKED_UP, DeliveryStatus.FAILED],
  [DeliveryStatus.PICKED_UP]: [
    DeliveryStatus.IN_TRANSIT,
    DeliveryStatus.FAILED,
  ],
  [DeliveryStatus.IN_TRANSIT]: [
    DeliveryStatus.DELIVERED,
    DeliveryStatus.FAILED,
  ],
  [DeliveryStatus.DELIVERED]: [],
  [DeliveryStatus.FAILED]: [],
  [DeliveryStatus.CANCELLED]: [],
};

export const ACTIVE_DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  DeliveryStatus.ASSIGNED,
  DeliveryStatus.ACCEPTED,
  DeliveryStatus.PICKED_UP,
  DeliveryStatus.IN_TRANSIT,
];

export const REASSIGNABLE_DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  DeliveryStatus.ASSIGNED,
  DeliveryStatus.ACCEPTED,
];

export const RIDER_FAILABLE_STATUSES: readonly DeliveryStatus[] = [
  DeliveryStatus.ASSIGNED,
  DeliveryStatus.ACCEPTED,
  DeliveryStatus.PICKED_UP,
  DeliveryStatus.IN_TRANSIT,
];

export const TERMINAL_DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  DeliveryStatus.DELIVERED,
  DeliveryStatus.FAILED,
  DeliveryStatus.CANCELLED,
];

export function canTransitionDeliveryStatus(
  from: DeliveryStatus,
  to: DeliveryStatus,
): boolean {
  return DELIVERY_STATUS_TRANSITIONS[from].includes(to);
}
