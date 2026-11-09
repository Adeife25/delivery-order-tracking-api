import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { NotificationStatus, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailSender } from './email.sender';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import {
  NotificationsQueue,
  RETRY_POLL_INTERVAL_MS,
} from './notifications.queue';
import { NotificationView, notificationSelect } from './notifications.select';

export interface CreateNotificationInput {
  userId: string;
  type: string;
  title: string;
  message: string;
}

const MAX_DELIVERY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 60_000;

function retryDelay(attempt: number): number {
  return RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
}

type NotificationWriter = Pick<Prisma.TransactionClient, 'notification'>;

@Injectable()
export class NotificationsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailSender: EmailSender,
    private readonly queue: NotificationsQueue,
  ) {}

  onApplicationBootstrap(): void {
    void this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    if (this.queue.isEnabled()) {
      try {
        await this.queue.scheduleSweep();
      } catch (error) {
        this.logger.warn(
          `Could not schedule notification sweep: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }

    await this.retryPending();
  }

  async notify(input: CreateNotificationInput): Promise<void> {
    try {
      const notificationId = await this.createInTransaction(this.prisma, input);
      void this.deliver(notificationId);
    } catch {
      this.logger.error(
        `Could not persist ${input.type} notification for user ${input.userId}`,
      );
    }
  }

  async createInTransaction(
    writer: NotificationWriter,
    input: CreateNotificationInput,
  ): Promise<string> {
    const notification = await writer.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        message: input.message,
        status: NotificationStatus.PENDING,
      },
      select: { id: true },
    });

    return notification.id;
  }

  async enqueue(notificationIds: readonly string[]): Promise<void> {
    await Promise.all(notificationIds.map((id) => this.deliver(id)));
  }

  async retryPending(): Promise<void> {
    try {
      const pending = await this.prisma.notification.findMany({
        where: {
          status: NotificationStatus.PENDING,
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
        },
        orderBy: { createdAt: 'asc' },
        take: 100,
        select: { id: true },
      });

      await Promise.all(pending.map(({ id }) => this.deliver(id)));
    } catch {
      this.logger.error('Could not load pending notifications');
    }
  }

  @Interval(RETRY_POLL_INTERVAL_MS)
  async retryDueNotifications(): Promise<void> {
    if (this.queue.isEnabled()) {
      return;
    }

    await this.retryPending();
  }

  private async deliver(notificationId: string): Promise<void> {
    try {
      const queued = await this.queue.enqueue(notificationId);

      if (queued) {
        return;
      }
    } catch (error) {
      this.logger.warn(
        `Could not enqueue notification ${notificationId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }

    await this.dispatch(notificationId);
  }

  async dispatch(notificationId: string): Promise<void> {
    if (this.inFlight.has(notificationId)) {
      return;
    }

    this.inFlight.add(notificationId);

    try {
      const notification = await this.prisma.notification.findUnique({
        where: { id: notificationId },
        select: {
          id: true,
          status: true,
          attempts: true,
          nextAttemptAt: true,
          title: true,
          message: true,
          user: { select: { email: true } },
        },
      });

      if (
        !notification ||
        notification.status !== NotificationStatus.PENDING ||
        (notification.nextAttemptAt && notification.nextAttemptAt > new Date())
      ) {
        return;
      }

      const claimed = await this.prisma.notification.updateMany({
        where: {
          id: notificationId,
          status: NotificationStatus.PENDING,
          attempts: notification.attempts,
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
        },
        data: { attempts: { increment: 1 } },
      });

      if (claimed.count !== 1) {
        return;
      }

      const attempt = notification.attempts + 1;

      try {
        await this.emailSender.send({
          to: notification.user.email,
          subject: notification.title,
          text: notification.message,
        });

        await this.prisma.notification.updateMany({
          where: {
            id: notificationId,
            status: NotificationStatus.PENDING,
          },
          data: {
            status: NotificationStatus.SENT,
            sentAt: new Date(),
            nextAttemptAt: null,
          },
        });
      } catch {
        if (attempt >= MAX_DELIVERY_ATTEMPTS) {
          await this.prisma.notification.updateMany({
            where: {
              id: notificationId,
              status: NotificationStatus.PENDING,
            },
            data: {
              status: NotificationStatus.FAILED,
              nextAttemptAt: null,
            },
          });

          this.logger.error(
            `Notification ${notificationId} failed after ${MAX_DELIVERY_ATTEMPTS} attempts`,
          );
        } else {
          await this.prisma.notification.updateMany({
            where: {
              id: notificationId,
              status: NotificationStatus.PENDING,
            },
            data: {
              nextAttemptAt: new Date(Date.now() + retryDelay(attempt)),
            },
          });
        }
      }
    } catch {
      this.logger.error(`Could not dispatch notification ${notificationId}`);
    } finally {
      this.inFlight.delete(notificationId);
    }
  }

  async list(
    userId: string,
    query: ListNotificationsQueryDto,
  ): Promise<{
    data: NotificationView[];
    meta: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }> {
    const where: Prisma.NotificationWhereInput = { userId };

    if (query.status) {
      where.status = query.status;
    }

    if (query.type) {
      where.type = query.type;
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: notificationSelect,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
