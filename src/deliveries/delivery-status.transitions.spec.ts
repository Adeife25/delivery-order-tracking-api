import { DeliveryStatus } from '../generated/prisma/enums';
import {
  ACTIVE_DELIVERY_STATUSES,
  canTransitionDeliveryStatus,
  DELIVERY_STATUS_TRANSITIONS,
  REASSIGNABLE_DELIVERY_STATUSES,
  RIDER_FAILABLE_STATUSES,
} from './delivery-status.transitions';

describe('delivery status transitions', () => {
  it('allows the happy path from assignment to delivery', () => {
    expect(
      canTransitionDeliveryStatus(
        DeliveryStatus.PENDING_ASSIGNMENT,
        DeliveryStatus.ASSIGNED,
      ),
    ).toBe(true);
    expect(
      canTransitionDeliveryStatus(
        DeliveryStatus.ASSIGNED,
        DeliveryStatus.ACCEPTED,
      ),
    ).toBe(true);
    expect(
      canTransitionDeliveryStatus(
        DeliveryStatus.ACCEPTED,
        DeliveryStatus.PICKED_UP,
      ),
    ).toBe(true);
    expect(
      canTransitionDeliveryStatus(
        DeliveryStatus.PICKED_UP,
        DeliveryStatus.IN_TRANSIT,
      ),
    ).toBe(true);
    expect(
      canTransitionDeliveryStatus(
        DeliveryStatus.IN_TRANSIT,
        DeliveryStatus.DELIVERED,
      ),
    ).toBe(true);
  });

  it('rejects skipping delivery milestones', () => {
    expect(
      canTransitionDeliveryStatus(
        DeliveryStatus.ASSIGNED,
        DeliveryStatus.PICKED_UP,
      ),
    ).toBe(false);
    expect(
      canTransitionDeliveryStatus(
        DeliveryStatus.ASSIGNED,
        DeliveryStatus.DELIVERED,
      ),
    ).toBe(false);
    expect(
      canTransitionDeliveryStatus(
        DeliveryStatus.PENDING_ASSIGNMENT,
        DeliveryStatus.ACCEPTED,
      ),
    ).toBe(false);
  });

  it('treats terminal statuses as final', () => {
    for (const terminal of [
      DeliveryStatus.DELIVERED,
      DeliveryStatus.FAILED,
      DeliveryStatus.CANCELLED,
    ]) {
      expect(DELIVERY_STATUS_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it('exposes the active, reassignable, and failable status sets', () => {
    expect(ACTIVE_DELIVERY_STATUSES).toEqual([
      DeliveryStatus.ASSIGNED,
      DeliveryStatus.ACCEPTED,
      DeliveryStatus.PICKED_UP,
      DeliveryStatus.IN_TRANSIT,
    ]);
    expect(REASSIGNABLE_DELIVERY_STATUSES).toEqual([
      DeliveryStatus.ASSIGNED,
      DeliveryStatus.ACCEPTED,
    ]);
    expect(RIDER_FAILABLE_STATUSES).toEqual(ACTIVE_DELIVERY_STATUSES);
  });
});
