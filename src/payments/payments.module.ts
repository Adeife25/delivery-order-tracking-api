import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrderPaymentsController } from './order-payments.controller';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaystackClient } from './paystack.client';

@Module({
  imports: [NotificationsModule],
  controllers: [OrderPaymentsController, PaymentsController],
  providers: [PaymentsService, PaystackClient],
})
export class PaymentsModule {}
