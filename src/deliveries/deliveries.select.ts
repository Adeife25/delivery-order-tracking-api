import { Prisma } from '../generated/prisma/client';

export const deliverySelect = {
  id: true,
  orderId: true,
  riderId: true,
  status: true,
  assignedAt: true,
  acceptedAt: true,
  pickedUpAt: true,
  deliveredAt: true,
  failureReason: true,
  createdAt: true,
  updatedAt: true,
  order: {
    select: {
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
    },
  },
  rider: {
    select: {
      id: true,
      fullName: true,
      phoneNumber: true,
    },
  },
} satisfies Prisma.DeliverySelect;

export type DeliveryView = Prisma.DeliveryGetPayload<{
  select: typeof deliverySelect;
}>;
