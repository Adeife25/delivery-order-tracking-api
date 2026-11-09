import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

export const NOTIFICATIONS_QUEUE = 'notifications';
export const SWEEP_JOB = 'sweep-pending';
export const RETRY_POLL_INTERVAL_MS = 60_000;

export interface NotificationJobData {
  id: string;
}

@Injectable()
export class NotificationsQueue implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationsQueue.name);
  private readonly queue?: Queue<NotificationJobData>;

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL');
    if (!url) {
      return;
    }

    this.queue = new Queue<NotificationJobData>(NOTIFICATIONS_QUEUE, {
      connection: { url, maxRetriesPerRequest: null },
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86_400, count: 5000 },
      },
    });

    this.queue.on('error', (error: Error) => {
      this.logger.error(`Notification queue error: ${error.message}`);
    });
  }

  isEnabled(): boolean {
    return Boolean(this.queue);
  }

  async enqueue(notificationId: string): Promise<boolean> {
    if (!this.queue) {
      return false;
    }

    await this.queue.add('deliver', { id: notificationId });

    return true;
  }

  async scheduleSweep(): Promise<void> {
    if (!this.queue) {
      return;
    }

    await this.queue.upsertJobScheduler(
      SWEEP_JOB,
      { every: RETRY_POLL_INTERVAL_MS },
      { name: 'sweep' },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }
}
