import { Prisma } from '../generated/prisma/client';

export const orderSelect = {
  id: true,
  orderNumber: true,
  customerId: true,
  pickupAddress: true,
  pickupLatitude: true,
  pickupLongitude: true,
  deliveryAddress: true,
  deliveryLatitude: true,
  deliveryLongitude: true,
  packageDescription: true,
  deliveryInstructions: true,
  deliveryFee: true,
  currency: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  delivery: {
    select: {
      id: true,
      riderId: true,
      status: true,
      assignedAt: true,
      acceptedAt: true,
      pickedUpAt: true,
      deliveredAt: true,
      failureReason: true,
      createdAt: true,
      updatedAt: true,
    },
  },
} satisfies Prisma.OrderSelect;

export type OrderView = Prisma.OrderGetPayload<{
  select: typeof orderSelect;
}>;

export const orderHistorySelect = {
  id: true,
  orderNumber: true,
  customerId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  delivery: {
    select: {
      id: true,
      riderId: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      statusHistory: {
        orderBy: { createdAt: 'asc' as const },
        select: {
          id: true,
          previousStatus: true,
          newStatus: true,
          changedById: true,
          createdAt: true,
        },
      },
    },
  },
} satisfies Prisma.OrderSelect;

export type OrderHistoryView = Prisma.OrderGetPayload<{
  select: typeof orderHistorySelect;
}>;
