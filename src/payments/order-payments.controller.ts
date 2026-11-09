import { Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RateLimit } from '../common/rate-limit.decorator';
import { UserRole } from '../generated/prisma/enums';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { paymentRateLimit } from '../common/throttle.config';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@ApiBearerAuth()
@Controller('orders/:orderId/payments')
export class OrderPaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  @RateLimit(paymentRateLimit)
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: 'Initialize a Paystack payment for an order' })
  @ApiCreatedResponse({
    description: 'The pending payment and Paystack checkout details',
  })
  initiate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.paymentsService.initiate(user, orderId);
  }
}
