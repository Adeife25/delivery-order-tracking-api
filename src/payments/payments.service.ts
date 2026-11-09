import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  OrderStatus,
  PaymentStatus,
  Prisma,
  UserRole,
} from '../generated/prisma/client';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { VerifyPaymentDto } from './dto/verify-payment.dto';
import { PaymentView, paymentSelect } from './payments.select';
import { PaystackClient } from './paystack.client';

export interface PaymentInitiationView {
  payment: PaymentView;
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

interface PaymentAmount {
  amount: Prisma.Decimal | string;
  currency: string;
}

interface ProviderAmount {
  amount: number;
  currency: string;
}

export function toMinorUnits(amount: Prisma.Decimal | string): number {
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

function isRetryableTransactionError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2034'
  );
}

type TransactionClient = Prisma.TransactionClient;

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
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

    const { order, payment, reference } = await this.serializable(
      async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: orderId },
          select: {
            id: true,
            orderNumber: true,
            customerId: true,
            deliveryFee: true,
            currency: true,
            status: true,
            customer: { select: { email: true } },
          },
        });

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

        const existing = await tx.payment.findFirst({
          where: {
            orderId,
            status: {
              in: [PaymentStatus.PENDING, PaymentStatus.SUCCEEDED],
            },
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true, status: true },
        });

        if (existing?.status === PaymentStatus.SUCCEEDED) {
          throw new ConflictException('Order has already been paid');
        }

        if (existing) {
          throw new ConflictException(
            'A payment is already pending for this order',
          );
        }

        const reference = this.generateReference(order.orderNumber);
        const payment = await tx.payment.create({
          data: {
            orderId,
            provider: 'paystack',
            providerReference: reference,
            amount: order.deliveryFee,
            currency: order.currency,
            status: PaymentStatus.PENDING,
          },
          select: paymentSelect,
        });

        return { order, payment, reference };
      },
    );

    try {
      const initialized = await this.paystack.initialize({
        email: order.customer.email,
        amount: toMinorUnits(order.deliveryFee),
        currency: order.currency,
        reference,
        metadata: {
          orderId,
          orderNumber: order.orderNumber,
          paymentId: payment.id,
        },
      });

      return {
        payment,
        authorizationUrl: initialized.authorization_url,
        accessCode: initialized.access_code,
        reference: initialized.reference,
      };
    } catch {
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.FAILED },
      });

      throw new BadGatewayException(
        'Unable to initiate payment with the provider',
      );
    }
  }

  async getById(user: AuthenticatedUser, id: string): Promise<PaymentView> {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      select: paymentSelect,
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

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

    const payment = await this.prisma.payment.findUnique({
      where: { providerReference: reference },
      select: {
        id: true,
        orderId: true,
        amount: true,
        currency: true,
      },
    });

    if (!payment) {
      return { received: true };
    }

    if (event.event === 'charge.success') {
      this.assertProviderMatches(payment, {
        amount: Number(data.amount),
        currency: typeof data.currency === 'string' ? data.currency : '',
      });

      await this.markSucceeded(
        payment.id,
        payment.orderId,
        typeof data.paid_at === 'string' ? data.paid_at : null,
      );
    } else if (['charge.failed', 'charge.abandoned'].includes(event.event)) {
      await this.markFailed(payment.id);
    }

    return { received: true };
  }

  private async findByReference(reference: string): Promise<PaymentView> {
    const payment = await this.prisma.payment.findUnique({
      where: { providerReference: reference },
      select: paymentSelect,
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    return payment;
  }

  private getPaymentById(id: string): Promise<PaymentView> {
    return this.prisma.payment.findUniqueOrThrow({
      where: { id },
      select: paymentSelect,
    });
  }

  private async markSucceeded(
    paymentId: string,
    orderId: string,
    paidAt: string | null | undefined,
  ): Promise<PaymentView> {
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.payment.updateMany({
        where: { id: paymentId, status: { not: PaymentStatus.SUCCEEDED } },
        data: {
          provider: 'paystack',
          status: PaymentStatus.SUCCEEDED,
          paidAt: parsePaidAt(paidAt),
        },
      });

      if (updated.count === 1) {
        await tx.order.updateMany({
          where: {
            id: orderId,
            status: OrderStatus.PENDING_PAYMENT,
          },
          data: { status: OrderStatus.CONFIRMED },
        });
      }

      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
        select: paymentSelect,
      });

      const notificationId =
        updated.count === 1
          ? await this.notifications.createInTransaction(tx, {
              userId: payment.order.customerId,
              type: 'PAYMENT_SUCCEEDED',
              title: 'Payment confirmed',
              message: `Payment for order ${payment.order.orderNumber} was confirmed. A rider can now be assigned.`,
            })
          : undefined;

      return { payment, notificationId };
    });

    if (result.notificationId) {
      void this.notifications.enqueue([result.notificationId]);
    }

    return result.payment;
  }

  private async markFailed(paymentId: string): Promise<void> {
    await this.prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.PENDING },
      data: { status: PaymentStatus.FAILED },
    });
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

  private async serializable<T>(
    operation: (tx: TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (!isRetryableTransactionError(error) || attempt === 2) {
          throw error;
        }
      }
    }

    throw new ConflictException('Could not complete the operation');
  }
}
