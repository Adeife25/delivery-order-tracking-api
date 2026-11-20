import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { ClientSession } from 'mongoose';
import { DatabaseService } from '../database/database.service';
import { NotificationStatus } from '../database/enums';
import { NotificationModel } from '../database/models';
import { NotificationDoc } from '../database/views';
import { EmailSender } from './email.sender';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import {
  NotificationsQueue,
  RETRY_POLL_INTERVAL_MS,
} from './notifications.queue';
import { NotificationView, toNotificationView } from './notifications.select';

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

@Injectable()
export class NotificationsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly database: DatabaseService,
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
      const notificationId = await this.createInTransaction(input);
      void this.deliver(notificationId);
    } catch {
      this.logger.error(
        `Could not persist ${input.type} notification for user ${input.userId}`,
      );
    }
  }

  async createInTransaction(
    input: CreateNotificationInput,
    session?: ClientSession,
  ): Promise<string> {
    const [notification] = await NotificationModel.create(
      [
        {
          userId: input.userId,
          type: input.type,
          title: input.title,
          message: input.message,
          status: NotificationStatus.PENDING,
          attempts: 0,
        },
      ],
      { session },
    );

    return notification._id.toString();
  }

  async enqueue(notificationIds: readonly string[]): Promise<void> {
    await Promise.all(notificationIds.map((id) => this.deliver(id)));
  }

  async retryPending(): Promise<void> {
    try {
      const pending = (await NotificationModel.find({
        status: NotificationStatus.PENDING,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: new Date() } }],
      })
        .sort({ createdAt: 1 })
        .limit(100)
        .select('_id')
        .lean()) as unknown as Array<{ _id: string }>;

      await Promise.all(pending.map(({ _id }) => this.deliver(_id)));
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
      const notification = (await NotificationModel.findById(notificationId)
        .populate('user', 'email')
        .lean()) as unknown as NotificationDoc | null;

      if (
        !notification ||
        notification.status !== NotificationStatus.PENDING ||
        (notification.nextAttemptAt && notification.nextAttemptAt > new Date())
      ) {
        return;
      }

      const claimed = await NotificationModel.updateOne(
        {
          _id: notificationId,
          status: NotificationStatus.PENDING,
          attempts: notification.attempts,
          $or: [
            { nextAttemptAt: null },
            { nextAttemptAt: { $lte: new Date() } },
          ],
        },
        { $inc: { attempts: 1 } },
      );

      if (claimed.modifiedCount !== 1) {
        return;
      }

      const attempt = notification.attempts + 1;

      try {
        await this.emailSender.send({
          to: notification.user?.email ?? '',
          subject: notification.title,
          text: notification.message,
        });

        await NotificationModel.updateOne(
          { _id: notificationId, status: NotificationStatus.PENDING },
          {
            $set: {
              status: NotificationStatus.SENT,
              sentAt: new Date(),
              nextAttemptAt: null,
            },
          },
        );
      } catch {
        if (attempt >= MAX_DELIVERY_ATTEMPTS) {
          await NotificationModel.updateOne(
            { _id: notificationId, status: NotificationStatus.PENDING },
            {
              $set: { status: NotificationStatus.FAILED, nextAttemptAt: null },
            },
          );

          this.logger.error(
            `Notification ${notificationId} failed after ${MAX_DELIVERY_ATTEMPTS} attempts`,
          );
        } else {
          await NotificationModel.updateOne(
            { _id: notificationId, status: NotificationStatus.PENDING },
            {
              $set: {
                nextAttemptAt: new Date(Date.now() + retryDelay(attempt)),
              },
            },
          );
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
    const where: Record<string, unknown> = { userId };

    if (query.status) {
      where.status = query.status;
    }

    if (query.type) {
      where.type = query.type;
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      NotificationModel.find(where)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      NotificationModel.countDocuments(where),
    ]);

    return {
      data: (data as unknown as NotificationDoc[]).map(toNotificationView),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
