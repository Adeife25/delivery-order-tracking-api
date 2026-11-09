import { Module } from '@nestjs/common';
import { EmailSender } from './email.sender';
import { NotificationsController } from './notifications.controller';
import { NotificationsQueue } from './notifications.queue';
import { NotificationsService } from './notifications.service';
import { NotificationsWorker } from './notifications.worker';

@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsQueue,
    NotificationsWorker,
    EmailSender,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
