import { Prisma } from '../generated/prisma/client';

export const notificationSelect = {
  id: true,
  userId: true,
  type: true,
  title: true,
  message: true,
  status: true,
  sentAt: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect;

export type NotificationView = Prisma.NotificationGetPayload<{
  select: typeof notificationSelect;
}>;
