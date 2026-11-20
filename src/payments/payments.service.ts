import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { OrderStatus, PaymentStatus, UserRole } from '../database/enums';
import { OrderModel, PaymentModel, UserModel } from '../database/models';
import { OrderDoc, PaymentDoc } from '../database/views';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { NotificationsService } from '../notifications/notifications.service';
import { VerifyPaymentDto } from './dto/verify-payment.dto';
import { PaymentView, paymentPopulate } from './payments.select';
import { PaystackClient } from './paystack.client';

export interface PaymentInitiationView {
  payment: PaymentView;
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

interface PaymentAmount {
  amount: string;
  currency: string;
}

interface ProviderAmount {
  amount: number;
  currency: string;
}

export function toMinorUnits(amount: string): number {
  const raw = amount.toString();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw);

  if (!match) {
    throw new Error('Invalid payment amount');
  }

  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

function parsePaidAt(value: string | null | undefined): Date {
  if (!value) {
    return new Date();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly paystack: PaystackClient,
    private readonly notifications: NotificationsService,
  ) {}

  async initiate(
    user: AuthenticatedUser,
    orderId: string,
  ): Promise<PaymentInitiationView> {
    if (!this.paystack.isConfigured()) {
      throw new ServiceUnavailableException(
        'Payment provider is not configured',
      );
    }

    const initiated = await this.database.withTransaction(async (session) => {
      const order = (await OrderModel.findOne({ _id: orderId }, null, {
        session,
      }).lean()) as unknown as OrderDoc | null;

      if (
        !order ||
        (user.role !== UserRole.ADMIN && order.customerId !== user.id)
      ) {
        throw new NotFoundException('Order not found');
      }

      if (order.status === OrderStatus.CANCELLED) {
        throw new ConflictException('Order has been cancelled');
      }

      if (order.status !== OrderStatus.PENDING_PAYMENT) {
        throw new ConflictException('Order is not awaiting payment');
      }

      const existing = (await PaymentModel.findOne(
        {
          orderId,
          status: { $in: [PaymentStatus.PENDING, PaymentStatus.SUCCEEDED] },
        },
        null,
        { session },
      )
        .sort({ createdAt: -1 })
        .lean()) as unknown as PaymentDoc | null;

      if (existing?.status === PaymentStatus.SUCCEEDED) {
        throw new ConflictException('Order has already been paid');
      }

      if (existing) {
        throw new ConflictException(
          'A payment is already pending for this order',
        );
      }

      const customer = await UserModel.findOne(
        { _id: order.customerId },
        null,
        { session },
      ).lean();

      if (!customer?.email) {
        throw new NotFoundException('Customer not found');
      }

      const reference = this.generateReference(order.orderNumber);
      const [payment] = await PaymentModel.create(
        [
          {
            orderId,
            provider: 'paystack',
            providerReference: reference,
            amount: order.deliveryFee,
            currency: order.currency,
            status: PaymentStatus.PENDING,
          },
        ],
        { session },
      );

      return {
        paymentId: payment._id.toString(),
        customerEmail: customer.email as string,
        amount: order.deliveryFee,
        currency: order.currency,
        reference,
        orderNumber: order.orderNumber,
      };
    });

    try {
      const initialized = await this.paystack.initialize({
        email: initiated.customerEmail,
        amount: toMinorUnits(initiated.amount),
        currency: initiated.currency,
        reference: initiated.reference,
        metadata: {
          orderId,
          orderNumber: initiated.orderNumber,
          paymentId: initiated.paymentId,
        },
      });

      return {
        payment: await this.getPaymentById(initiated.paymentId),
        authorizationUrl: initialized.authorization_url,
        accessCode: initialized.access_code,
        reference: initialized.reference,
      };
    } catch {
      await PaymentModel.updateMany(
        { _id: initiated.paymentId, status: PaymentStatus.PENDING },
        { $set: { status: PaymentStatus.FAILED } },
      );

      throw new BadGatewayException(
        'Unable to initiate payment with the provider',
      );
    }
  }

  async getById(user: AuthenticatedUser, id: string): Promise<PaymentView> {
    const payment = await this.getPaymentById(id);
    this.assertCanView(user, payment.order.customerId);
    return payment;
  }

  async verify(
    user: AuthenticatedUser,
    dto: VerifyPaymentDto,
  ): Promise<PaymentView> {
    const payment = await this.findByReference(dto.reference);
    this.assertCanView(user, payment.order.customerId);

    if (payment.status === PaymentStatus.SUCCEEDED) {
      return payment;
    }

    if (!this.paystack.isConfigured()) {
      throw new ServiceUnavailableException(
        'Payment provider is not configured',
      );
    }

    let transaction;
    try {
      transaction = await this.paystack.verify(dto.reference);
    } catch {
      throw new BadGatewayException(
        'Unable to verify payment with the provider',
      );
    }

    if (transaction.status === 'success') {
      this.assertProviderMatches(payment, {
        amount: transaction.amount,
        currency: transaction.currency,
      });

      return this.markSucceeded(
        payment.id,
        payment.orderId,
        transaction.paid_at,
      );
    }

    if (['failed', 'abandoned', 'reversed'].includes(transaction.status)) {
      await this.markFailed(payment.id);
      return this.getPaymentById(payment.id);
    }

    return payment;
  }

  async handleWebhook(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<{ received: true }> {
    if (!rawBody || !signature) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    if (!this.paystack.isConfigured()) {
      throw new ServiceUnavailableException(
        'Payment provider is not configured',
      );
    }

    if (!this.paystack.verifyWebhookSignature(rawBody, signature)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let event: { event?: unknown; data?: unknown };
    try {
      event = JSON.parse(rawBody.toString('utf8')) as {
        event?: unknown;
        data?: unknown;
      };
    } catch {
      throw new BadRequestException('Invalid webhook payload');
    }

    if (
      typeof event.event !== 'string' ||
      !event.data ||
      typeof event.data !== 'object'
    ) {
      throw new BadRequestException('Invalid webhook payload');
    }

    const data = event.data as Record<string, unknown>;
    const reference = data.reference;

    if (typeof reference !== 'string') {
      return { received: true };
    }

    const payment = (await PaymentModel.findOne({
      providerReference: reference,
    })
      .select('_id orderId amount currency')
      .lean()) as unknown as PaymentDoc | null;

    if (!payment) {
      return { received: true };
    }

    if (event.event === 'charge.success') {
      this.assertProviderMatches(payment, {
        amount: Number(data.amount),
        currency: typeof data.currency === 'string' ? data.currency : '',
      });

      await this.markSucceeded(
        payment._id,
        payment.orderId,
        typeof data.paid_at === 'string' ? data.paid_at : null,
      );
    } else if (['charge.failed', 'charge.abandoned'].includes(event.event)) {
      await this.markFailed(payment._id);
    }

    return { received: true };
  }

  private async findByReference(reference: string): Promise<PaymentView> {
    const payment = (await PaymentModel.findOne({
      providerReference: reference,
    })
      .populate(paymentPopulate)
      .lean()) as unknown as PaymentDoc | null;

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    return this.toView(payment);
  }

  private async getPaymentById(id: string): Promise<PaymentView> {
    const payment = (await PaymentModel.findById(id)
      .populate(paymentPopulate)
      .lean()) as unknown as PaymentDoc | null;

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    return this.toView(payment);
  }

  private toView(payment: PaymentDoc): PaymentView {
    if (!payment.order) {
      throw new NotFoundException('Payment order was not found');
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
      order: {
        id: payment.order._id,
        orderNumber: payment.order.orderNumber,
        customerId: payment.order.customerId,
        status: payment.order.status,
      },
    };
  }

  private async markSucceeded(
    paymentId: string,
    orderId: string,
    paidAt: string | null | undefined,
  ): Promise<PaymentView> {
    const result = await this.database.withTransaction(async (session) => {
      const updated = await PaymentModel.updateOne(
        { _id: paymentId, status: { $ne: PaymentStatus.SUCCEEDED } },
        {
          $set: {
            provider: 'paystack',
            status: PaymentStatus.SUCCEEDED,
            paidAt: parsePaidAt(paidAt),
          },
        },
        { session },
      );

      let notificationId: string | undefined;

      if (updated.modifiedCount === 1) {
        await OrderModel.updateOne(
          { _id: orderId, status: OrderStatus.PENDING_PAYMENT },
          { $set: { status: OrderStatus.CONFIRMED } },
          { session },
        );

        const order = (await OrderModel.findOne({ _id: orderId }, null, {
          session,
        }).lean()) as unknown as OrderDoc | null;

        if (order) {
          notificationId = await this.notifications.createInTransaction(
            {
              userId: order.customerId,
              type: 'PAYMENT_SUCCEEDED',
              title: 'Payment confirmed',
              message: `Payment for order ${order.orderNumber} was confirmed. A rider can now be assigned.`,
            },
            session,
          );
        }
      }

      return { notificationId };
    });

    if (result.notificationId) {
      void this.notifications.enqueue([result.notificationId]);
    }

    return this.getPaymentById(paymentId);
  }

  private async markFailed(paymentId: string): Promise<void> {
    await PaymentModel.updateMany(
      { _id: paymentId, status: PaymentStatus.PENDING },
      { $set: { status: PaymentStatus.FAILED } },
    );
  }

  private assertProviderMatches(
    payment: PaymentAmount,
    provider: ProviderAmount,
  ): void {
    const expectedAmount = toMinorUnits(payment.amount);
    const expectedCurrency = payment.currency.trim().toUpperCase();
    const providerCurrency = provider.currency.trim().toUpperCase();

    if (
      !Number.isInteger(provider.amount) ||
      provider.amount !== expectedAmount ||
      providerCurrency !== expectedCurrency
    ) {
      throw new BadRequestException('Payment details do not match the order');
    }
  }

  private assertCanView(user: AuthenticatedUser, customerId: string): void {
    if (user.role === UserRole.ADMIN || customerId === user.id) {
      return;
    }

    throw new NotFoundException('Payment not found');
  }

  private generateReference(orderNumber: string): string {
    const normalized = orderNumber.replace(/[^A-Za-z0-9]/g, '');
    return `PAY-${normalized}-${randomUUID().slice(0, 8).toUpperCase()}`;
  }
}
