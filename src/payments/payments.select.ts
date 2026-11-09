import { Prisma } from '../generated/prisma/client';

export const paymentSelect = {
  id: true,
  orderId: true,
  provider: true,
  providerReference: true,
  amount: true,
  currency: true,
  status: true,
  paidAt: true,
  createdAt: true,
  updatedAt: true,
  order: {
    select: {
      id: true,
      orderNumber: true,
      customerId: true,
      status: true,
    },
  },
} satisfies Prisma.PaymentSelect;

export type PaymentView = Prisma.PaymentGetPayload<{
  select: typeof paymentSelect;
}>;
