import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import {
  NOTIFICATIONS_QUEUE,
  type NotificationJobData,
} from './notifications.queue';
import { NotificationsService } from './notifications.service';

@Injectable()
export class NotificationsWorker implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationsWorker.name);
  private readonly worker?: Worker<NotificationJobData>;

  constructor(
    config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {
    const url = config.get<string>('REDIS_URL');
    if (!url) {
      return;
    }

    const concurrency = Number(
      config.get<number>('NOTIFICATION_WORKER_CONCURRENCY', 5),
    );

    this.worker = new Worker<NotificationJobData>(
      NOTIFICATIONS_QUEUE,
      async (job) => {
        if (job.name === 'deliver') {
          await this.notifications.dispatch(job.data.id);
          return;
        }

        if (job.name === 'sweep') {
          await this.notifications.retryPending();
        }
      },
      {
        connection: { url, maxRetriesPerRequest: null },
        concurrency,
      },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `Notification job ${job?.id ?? 'unknown'} failed: ${error.message}`,
      );
    });

    this.worker.on('error', (error: Error) => {
      this.logger.error(`Notification worker error: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
