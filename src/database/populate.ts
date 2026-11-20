import type { PopulateOptions } from 'mongoose';

export const USER_SUMMARY_FIELDS = '_id fullName phoneNumber';
export const USER_PUBLIC_FIELDS =
  '_id fullName email phoneNumber role isActive createdAt updatedAt';
export const DELIVERY_SUMMARY_FIELDS =
  '_id orderId riderId status assignedAt acceptedAt pickedUpAt deliveredAt failureReason createdAt updatedAt';
export const ORDER_DOCUMENT_FIELDS =
  '_id orderNumber customerId pickupAddress pickupLatitude pickupLongitude deliveryAddress deliveryLatitude deliveryLongitude packageDescription deliveryInstructions deliveryFee currency status createdAt updatedAt';
export const ORDER_SUMMARY_FIELDS = '_id orderNumber customerId status';
export const STATUS_HISTORY_FIELDS =
  '_id previousStatus newStatus changedById createdAt';
export const TRACKING_LOCATION_FIELDS =
  '_id deliveryId latitude longitude recordedAt';
export const NOTIFICATION_FIELDS =
  '_id userId type title message status sentAt createdAt';

export const deliveryPopulate: PopulateOptions[] = [
  { path: 'order', select: ORDER_DOCUMENT_FIELDS },
  { path: 'rider', select: USER_SUMMARY_FIELDS },
];

export const orderPopulate: PopulateOptions[] = [
  { path: 'delivery', select: DELIVERY_SUMMARY_FIELDS },
];

export const orderHistoryPopulate: PopulateOptions[] = [
  {
    path: 'delivery',
    select: DELIVERY_SUMMARY_FIELDS,
    populate: {
      path: 'statusHistory',
      select: STATUS_HISTORY_FIELDS,
      options: { sort: { createdAt: 1 } },
    },
  },
];

export const paymentPopulate: PopulateOptions[] = [
  { path: 'order', select: ORDER_SUMMARY_FIELDS },
];
