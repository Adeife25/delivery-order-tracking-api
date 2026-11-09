import { DeliveryStatus } from '../generated/prisma/client';
import { calculateRiderMetrics } from './admin.service';

describe('calculateRiderMetrics', () => {
  it('returns empty metrics for a rider without deliveries', () => {
    expect(calculateRiderMetrics([], 2)).toEqual({
      totalAssignments: 2,
      totalDeliveries: 0,
      activeDeliveries: 0,
      completed: 0,
      failed: 0,
      completionRate: null,
      averageAcceptanceSeconds: null,
      averageDeliveryMinutes: null,
      lastDeliveredAt: null,
    });
  });

  it('calculates completion, timing, and last-delivery metrics', () => {
    const start = new Date('2026-11-01T10:00:00.000Z');
    const minutes = (value: number) =>
      new Date(start.getTime() + value * 60 * 1000);

    const metrics = calculateRiderMetrics(
      [
        {
          status: DeliveryStatus.DELIVERED,
          assignedAt: minutes(0),
          acceptedAt: minutes(2),
          pickedUpAt: minutes(5),
          deliveredAt: minutes(25),
        },
        {
          status: DeliveryStatus.FAILED,
          assignedAt: minutes(60),
          acceptedAt: minutes(61),
          pickedUpAt: minutes(63),
          deliveredAt: null,
        },
        {
          status: DeliveryStatus.IN_TRANSIT,
          assignedAt: minutes(120),
          acceptedAt: minutes(122),
          pickedUpAt: minutes(125),
          deliveredAt: null,
        },
      ],
      4,
    );

    expect(metrics).toMatchObject({
      totalAssignments: 4,
      totalDeliveries: 3,
      activeDeliveries: 1,
      completed: 1,
      failed: 1,
      completionRate: 50,
      averageAcceptanceSeconds: 100,
      averageDeliveryMinutes: 20,
    });
    expect(metrics.lastDeliveredAt).toEqual(minutes(25));
  });
});
