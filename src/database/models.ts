import { Schema, Types, model } from 'mongoose';
import {
  ALL_DELIVERY_STATUSES,
  ALL_NOTIFICATION_STATUSES,
  ALL_ORDER_STATUSES,
  ALL_PAYMENT_STATUSES,
  ALL_USER_ROLES,
  DeliveryStatus,
  NotificationStatus,
  OrderStatus,
  PaymentStatus,
  UserRole,
} from './enums';
import type {
  DeliveryAssignmentDoc,
  DeliveryDoc,
  DeliveryLocationDoc,
  DeliveryStatusHistoryDoc,
  NotificationDoc,
  OrderDoc,
  PaymentDoc,
  RefreshTokenDoc,
  UserDoc,
} from './views';

const newId = (): string => new Types.ObjectId().toString();

const schemaOptions = {
  versionKey: false as const,
  toJSON: { virtuals: true as const },
  toObject: { virtuals: true as const },
};

const UserSchema = new Schema<UserDoc>(
  {
    _id: { type: String, default: newId },
    fullName: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    phoneNumber: { type: String, default: null },
    role: { type: String, enum: ALL_USER_ROLES, default: UserRole.CUSTOMER },
    isActive: { type: Boolean, default: true },
  },
  { ...schemaOptions, collection: 'users', timestamps: true },
);
UserSchema.index({ role: 1, isActive: 1 });

const OrderSchema = new Schema<OrderDoc>(
  {
    _id: { type: String, default: newId },
    orderNumber: { type: String, required: true, unique: true },
    customerId: { type: String, required: true, ref: 'User' },
    pickupAddress: { type: String, required: true },
    pickupLatitude: { type: Number, default: null },
    pickupLongitude: { type: Number, default: null },
    deliveryAddress: { type: String, required: true },
    deliveryLatitude: { type: Number, default: null },
    deliveryLongitude: { type: Number, default: null },
    packageDescription: { type: String, required: true },
    deliveryInstructions: { type: String, default: null },
    deliveryFee: { type: String, required: true },
    currency: { type: String, required: true },
    status: {
      type: String,
      enum: ALL_ORDER_STATUSES,
      default: OrderStatus.PENDING_PAYMENT,
    },
  },
  { ...schemaOptions, collection: 'orders', timestamps: true },
);
OrderSchema.virtual('delivery', {
  ref: 'Delivery',
  localField: '_id',
  foreignField: 'orderId',
  justOne: true,
});
OrderSchema.index({ customerId: 1, createdAt: 1 });
OrderSchema.index({ status: 1, createdAt: 1 });

const DeliverySchema = new Schema<DeliveryDoc>(
  {
    _id: { type: String, default: newId },
    orderId: { type: String, required: true, unique: true, ref: 'Order' },
    riderId: { type: String, default: null, ref: 'User' },
    status: {
      type: String,
      enum: ALL_DELIVERY_STATUSES,
      default: DeliveryStatus.PENDING_ASSIGNMENT,
    },
    assignedAt: { type: Date, default: null },
    acceptedAt: { type: Date, default: null },
    pickedUpAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
  },
  { ...schemaOptions, collection: 'deliveries', timestamps: true },
);
DeliverySchema.virtual('order', {
  ref: 'Order',
  localField: 'orderId',
  foreignField: '_id',
  justOne: true,
});
DeliverySchema.virtual('rider', {
  ref: 'User',
  localField: 'riderId',
  foreignField: '_id',
  justOne: true,
});
DeliverySchema.virtual('locations', {
  ref: 'DeliveryLocation',
  localField: '_id',
  foreignField: 'deliveryId',
});
DeliverySchema.virtual('statusHistory', {
  ref: 'DeliveryStatusHistory',
  localField: '_id',
  foreignField: 'deliveryId',
});
DeliverySchema.virtual('assignments', {
  ref: 'DeliveryAssignment',
  localField: '_id',
  foreignField: 'deliveryId',
});
DeliverySchema.index({ riderId: 1, status: 1 });
DeliverySchema.index({ status: 1, createdAt: 1 });

const PaymentSchema = new Schema<PaymentDoc>(
  {
    _id: { type: String, default: newId },
    orderId: { type: String, required: true, ref: 'Order' },
    provider: { type: String, default: null },
    providerReference: {
      type: String,
      default: null,
      unique: true,
      sparse: true,
    },
    amount: { type: String, required: true },
    currency: { type: String, required: true },
    status: {
      type: String,
      enum: ALL_PAYMENT_STATUSES,
      default: PaymentStatus.PENDING,
    },
    paidAt: { type: Date, default: null },
  },
  { ...schemaOptions, collection: 'payments', timestamps: true },
);
PaymentSchema.virtual('order', {
  ref: 'Order',
  localField: 'orderId',
  foreignField: '_id',
  justOne: true,
});
PaymentSchema.index({ orderId: 1, createdAt: 1 });
PaymentSchema.index({ status: 1, createdAt: 1 });

const DeliveryLocationSchema = new Schema<DeliveryLocationDoc>(
  {
    _id: { type: String, default: newId },
    deliveryId: { type: String, required: true, ref: 'Delivery' },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    recordedAt: { type: Date, default: () => new Date() },
  },
  { ...schemaOptions, collection: 'deliverylocations', timestamps: true },
);
DeliveryLocationSchema.index({ deliveryId: 1, recordedAt: 1 });

const NotificationSchema = new Schema<NotificationDoc>(
  {
    _id: { type: String, default: newId },
    userId: { type: String, required: true, ref: 'User' },
    type: { type: String, required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    status: {
      type: String,
      enum: ALL_NOTIFICATION_STATUSES,
      default: NotificationStatus.PENDING,
    },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
  },
  { ...schemaOptions, collection: 'notifications', timestamps: true },
);
NotificationSchema.virtual('user', {
  ref: 'User',
  localField: 'userId',
  foreignField: '_id',
  justOne: true,
});
NotificationSchema.index({ userId: 1, createdAt: 1 });
NotificationSchema.index({ status: 1, createdAt: 1 });
NotificationSchema.index({ status: 1, nextAttemptAt: 1 });

const DeliveryStatusHistorySchema = new Schema<DeliveryStatusHistoryDoc>(
  {
    _id: { type: String, default: newId },
    deliveryId: { type: String, required: true, ref: 'Delivery' },
    previousStatus: {
      type: String,
      enum: ALL_DELIVERY_STATUSES,
      default: null,
    },
    newStatus: { type: String, enum: ALL_DELIVERY_STATUSES, required: true },
    changedById: { type: String, default: null, ref: 'User' },
  },
  { ...schemaOptions, collection: 'deliverystatushistories', timestamps: true },
);
DeliveryStatusHistorySchema.virtual('changedBy', {
  ref: 'User',
  localField: 'changedById',
  foreignField: '_id',
  justOne: true,
});
DeliveryStatusHistorySchema.index({ deliveryId: 1, createdAt: 1 });

const DeliveryAssignmentSchema = new Schema<DeliveryAssignmentDoc>(
  {
    _id: { type: String, default: newId },
    deliveryId: { type: String, required: true, ref: 'Delivery' },
    riderId: { type: String, required: true, ref: 'User' },
    assignedById: { type: String, required: true, ref: 'User' },
    assignedAt: { type: Date, default: () => new Date() },
    endedAt: { type: Date, default: null },
  },
  { ...schemaOptions, collection: 'deliveryassignments', timestamps: true },
);
DeliveryAssignmentSchema.virtual('rider', {
  ref: 'User',
  localField: 'riderId',
  foreignField: '_id',
  justOne: true,
});
DeliveryAssignmentSchema.virtual('assignedBy', {
  ref: 'User',
  localField: 'assignedById',
  foreignField: '_id',
  justOne: true,
});
DeliveryAssignmentSchema.index({ deliveryId: 1, assignedAt: 1 });
DeliveryAssignmentSchema.index({ riderId: 1, assignedAt: 1 });

const RefreshTokenSchema = new Schema<RefreshTokenDoc>(
  {
    _id: { type: String, default: newId },
    userId: { type: String, required: true, ref: 'User' },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  { ...schemaOptions, collection: 'refreshtokens', timestamps: true },
);
RefreshTokenSchema.virtual('user', {
  ref: 'User',
  localField: 'userId',
  foreignField: '_id',
  justOne: true,
});
RefreshTokenSchema.index({ userId: 1, revokedAt: 1 });
RefreshTokenSchema.index({ expiresAt: 1 });

export const UserModel = model<UserDoc>('User', UserSchema);
export const OrderModel = model<OrderDoc>('Order', OrderSchema);
export const DeliveryModel = model<DeliveryDoc>('Delivery', DeliverySchema);
export const PaymentModel = model<PaymentDoc>('Payment', PaymentSchema);
export const DeliveryLocationModel = model<DeliveryLocationDoc>(
  'DeliveryLocation',
  DeliveryLocationSchema,
);
export const NotificationModel = model<NotificationDoc>(
  'Notification',
  NotificationSchema,
);
export const DeliveryStatusHistoryModel = model<DeliveryStatusHistoryDoc>(
  'DeliveryStatusHistory',
  DeliveryStatusHistorySchema,
);
export const DeliveryAssignmentModel = model<DeliveryAssignmentDoc>(
  'DeliveryAssignment',
  DeliveryAssignmentSchema,
);
export const RefreshTokenModel = model<RefreshTokenDoc>(
  'RefreshToken',
  RefreshTokenSchema,
);

export const allModels = [
  UserModel,
  OrderModel,
  DeliveryModel,
  PaymentModel,
  DeliveryLocationModel,
  NotificationModel,
  DeliveryStatusHistoryModel,
  DeliveryAssignmentModel,
  RefreshTokenModel,
];
