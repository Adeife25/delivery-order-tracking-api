import {
  DeliveryStatus,
  NotificationStatus,
  OrderStatus,
  PaymentStatus,
  UserRole,
} from './enums';

export interface UserDoc {
  _id: string;
  fullName: string;
  email: string;
  passwordHash: string;
  phoneNumber: string | null;
  role: UserRole;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderDoc {
  _id: string;
  orderNumber: string;
  customerId: string;
  pickupAddress: string;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
  deliveryAddress: string;
  deliveryLatitude: number | null;
  deliveryLongitude: number | null;
  packageDescription: string;
  deliveryInstructions: string | null;
  deliveryFee: string;
  currency: string;
  status: OrderStatus;
  createdAt: Date;
  updatedAt: Date;
  delivery?: DeliveryDoc | null;
}

export interface DeliveryDoc {
  _id: string;
  orderId: string;
  riderId: string | null;
  status: DeliveryStatus;
  assignedAt: Date | null;
  acceptedAt: Date | null;
  pickedUpAt: Date | null;
  deliveredAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  order?: OrderDoc | null;
  rider?: UserDoc | null;
  statusHistory?: DeliveryStatusHistoryDoc[];
}

export interface PaymentDoc {
  _id: string;
  orderId: string;
  provider: string | null;
  providerReference: string | null;
  amount: string;
  currency: string;
  status: PaymentStatus;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  order?: Pick<
    OrderDoc,
    '_id' | 'orderNumber' | 'customerId' | 'status'
  > | null;
}

export interface DeliveryLocationDoc {
  _id: string;
  deliveryId: string;
  latitude: number;
  longitude: number;
  recordedAt: Date;
}

export interface NotificationDoc {
  _id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  status: NotificationStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  user?: UserDoc | null;
}

export interface DeliveryStatusHistoryDoc {
  _id: string;
  deliveryId: string;
  previousStatus: DeliveryStatus | null;
  newStatus: DeliveryStatus;
  changedById: string | null;
  createdAt: Date;
}

export interface DeliveryAssignmentDoc {
  _id: string;
  deliveryId: string;
  riderId: string;
  assignedById: string;
  assignedAt: Date;
  endedAt: Date | null;
}

export interface RefreshTokenDoc {
  _id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  user?: UserDoc | null;
}

export interface PublicUser {
  id: string;
  fullName: string;
  email: string;
  phoneNumber: string | null;
  role: UserRole;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderView {
  id: string;
  orderNumber: string;
  customerId: string;
  pickupAddress: string;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
  deliveryAddress: string;
  deliveryLatitude: number | null;
  deliveryLongitude: number | null;
  packageDescription: string;
  deliveryInstructions: string | null;
  deliveryFee: string;
  currency: string;
  status: OrderStatus;
  createdAt: Date;
  updatedAt: Date;
  delivery: DeliverySummary | null;
}

export interface DeliverySummary {
  id: string;
  riderId: string | null;
  status: DeliveryStatus;
  assignedAt: Date | null;
  acceptedAt: Date | null;
  pickedUpAt: Date | null;
  deliveredAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RiderSummary {
  id: string;
  fullName: string;
  phoneNumber: string | null;
}

export interface OrderSummary {
  id: string;
  orderNumber: string;
  customerId: string;
  status: OrderStatus;
}

export interface DeliveryView {
  id: string;
  orderId: string;
  riderId: string | null;
  status: DeliveryStatus;
  assignedAt: Date | null;
  acceptedAt: Date | null;
  pickedUpAt: Date | null;
  deliveredAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  order: OrderDocumentView;
  rider: RiderSummary | null;
}

export interface OrderDocumentView {
  id: string;
  orderNumber: string;
  customerId: string;
  pickupAddress: string;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
  deliveryAddress: string;
  deliveryLatitude: number | null;
  deliveryLongitude: number | null;
  packageDescription: string;
  deliveryInstructions: string | null;
  deliveryFee: string;
  currency: string;
  status: OrderStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentView {
  id: string;
  orderId: string;
  provider: string | null;
  providerReference: string | null;
  amount: string;
  currency: string;
  status: PaymentStatus;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  order: OrderSummary;
}

export interface NotificationView {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  status: NotificationStatus;
  sentAt: Date | null;
  createdAt: Date;
}

export interface TrackingLocation {
  id: string;
  deliveryId: string;
  latitude: string;
  longitude: string;
  recordedAt: Date;
}

export interface TrackingStatusHistory {
  id: string;
  previousStatus: DeliveryStatus | null;
  newStatus: DeliveryStatus;
  changedById: string | null;
  createdAt: Date;
}

export interface OrderHistoryView {
  id: string;
  orderNumber: string;
  customerId: string;
  status: OrderStatus;
  createdAt: Date;
  updatedAt: Date;
  delivery:
    (DeliverySummary & { statusHistory: TrackingStatusHistory[] }) | null;
}

export function toPublicUser(user: UserDoc): PublicUser {
  return {
    id: user._id,
    fullName: user.fullName,
    email: user.email,
    phoneNumber: user.phoneNumber ?? null,
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function toDeliverySummary(delivery: DeliveryDoc): DeliverySummary {
  return {
    id: delivery._id,
    riderId: delivery.riderId ?? null,
    status: delivery.status,
    assignedAt: delivery.assignedAt ?? null,
    acceptedAt: delivery.acceptedAt ?? null,
    pickedUpAt: delivery.pickedUpAt ?? null,
    deliveredAt: delivery.deliveredAt ?? null,
    failureReason: delivery.failureReason ?? null,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
}

export function toOrderDocumentView(order: OrderDoc): OrderDocumentView {
  return {
    id: order._id,
    orderNumber: order.orderNumber,
    customerId: order.customerId,
    pickupAddress: order.pickupAddress,
    pickupLatitude: order.pickupLatitude ?? null,
    pickupLongitude: order.pickupLongitude ?? null,
    deliveryAddress: order.deliveryAddress,
    deliveryLatitude: order.deliveryLatitude ?? null,
    deliveryLongitude: order.deliveryLongitude ?? null,
    packageDescription: order.packageDescription,
    deliveryInstructions: order.deliveryInstructions ?? null,
    deliveryFee: order.deliveryFee,
    currency: order.currency,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

export function toOrderView(order: OrderDoc): OrderView {
  return {
    ...toOrderDocumentView(order),
    delivery: order.delivery ? toDeliverySummary(order.delivery) : null,
  };
}

export function toOrderHistoryView(order: OrderDoc): OrderHistoryView {
  return {
    id: order._id,
    orderNumber: order.orderNumber,
    customerId: order.customerId,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    delivery: order.delivery
      ? {
          ...toDeliverySummary(order.delivery),
          statusHistory: (order.delivery.statusHistory ?? []).map(
            toTrackingStatusHistory,
          ),
        }
      : null,
  };
}

export function toRiderSummary(user: UserDoc): RiderSummary {
  return {
    id: user._id,
    fullName: user.fullName,
    phoneNumber: user.phoneNumber ?? null,
  };
}

export function toDeliveryView(delivery: DeliveryDoc): DeliveryView {
  if (!delivery.order) {
    throw new Error('Delivery order relation was not loaded');
  }

  return {
    id: delivery._id,
    orderId: delivery.orderId,
    riderId: delivery.riderId ?? null,
    status: delivery.status,
    assignedAt: delivery.assignedAt ?? null,
    acceptedAt: delivery.acceptedAt ?? null,
    pickedUpAt: delivery.pickedUpAt ?? null,
    deliveredAt: delivery.deliveredAt ?? null,
    failureReason: delivery.failureReason ?? null,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
    order: toOrderDocumentView(delivery.order),
    rider: delivery.rider ? toRiderSummary(delivery.rider) : null,
  };
}

export function toOrderSummary(
  order: Pick<OrderDoc, '_id' | 'orderNumber' | 'customerId' | 'status'>,
): OrderSummary {
  return {
    id: order._id,
    orderNumber: order.orderNumber,
    customerId: order.customerId,
    status: order.status,
  };
}

export function toPaymentView(payment: PaymentDoc): PaymentView {
  if (!payment.order) {
    throw new Error('Payment order relation was not loaded');
  }

  return {
    id: payment._id,
    orderId: payment.orderId,
    provider: payment.provider ?? null,
    providerReference: payment.providerReference ?? null,
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status,
    paidAt: payment.paidAt ?? null,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
    order: toOrderSummary(payment.order),
  };
}

export function toNotificationView(
  notification: NotificationDoc,
): NotificationView {
  return {
    id: notification._id,
    userId: notification.userId,
    type: notification.type,
    title: notification.title,
    message: notification.message,
    status: notification.status,
    sentAt: notification.sentAt ?? null,
    createdAt: notification.createdAt,
  };
}

export function toTrackingLocation(
  location: DeliveryLocationDoc,
): TrackingLocation {
  return {
    id: location._id,
    deliveryId: location.deliveryId,
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    recordedAt: location.recordedAt,
  };
}

export function toTrackingStatusHistory(
  history: DeliveryStatusHistoryDoc,
): TrackingStatusHistory {
  return {
    id: history._id,
    previousStatus: history.previousStatus ?? null,
    newStatus: history.newStatus,
    changedById: history.changedById ?? null,
    createdAt: history.createdAt,
  };
}
