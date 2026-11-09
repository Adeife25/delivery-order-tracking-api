import { Module } from '@nestjs/common';
import { DeliveriesModule } from '../deliveries/deliveries.module';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AdminDeliveriesController } from './admin-deliveries.controller';
import { AdminOrdersController } from './admin-orders.controller';
import { AdminPaymentsController } from './admin-payments.controller';
import { AdminRidersController } from './admin-riders.controller';
import { AdminUsersController } from './admin-users.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [DeliveriesModule],
  controllers: [
    AdminDashboardController,
    AdminDeliveriesController,
    AdminOrdersController,
    AdminPaymentsController,
    AdminRidersController,
    AdminUsersController,
  ],
  providers: [AdminService],
})
export class AdminModule {}
