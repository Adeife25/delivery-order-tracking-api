export const UserRole = {
  CUSTOMER: 'CUSTOMER',
  RIDER: 'RIDER',
  ADMIN: 'ADMIN',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const OrderStatus = {
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  CONFIRMED: 'CONFIRMED',
  CANCELLED: 'CANCELLED',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const DeliveryStatus = {
  PENDING_ASSIGNMENT: 'PENDING_ASSIGNMENT',
  ASSIGNED: 'ASSIGNED',
  ACCEPTED: 'ACCEPTED',
  PICKED_UP: 'PICKED_UP',
  IN_TRANSIT: 'IN_TRANSIT',
  DELIVERED: 'DELIVERED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type DeliveryStatus =
  (typeof DeliveryStatus)[keyof typeof DeliveryStatus];

export const PaymentStatus = {
  PENDING: 'PENDING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const NotificationStatus = {
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
} as const;
export type NotificationStatus =
  (typeof NotificationStatus)[keyof typeof NotificationStatus];

export const ALL_USER_ROLES: readonly string[] = Object.values(UserRole);
export const ALL_ORDER_STATUSES: readonly string[] = Object.values(OrderStatus);
export const ALL_DELIVERY_STATUSES: readonly string[] =
  Object.values(DeliveryStatus);
export const ALL_PAYMENT_STATUSES: readonly string[] =
  Object.values(PaymentStatus);
export const ALL_NOTIFICATION_STATUSES: readonly string[] =
  Object.values(NotificationStatus);
