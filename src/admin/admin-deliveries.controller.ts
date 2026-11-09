import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '../generated/prisma/enums';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { DeliveriesService } from '../deliveries/deliveries.service';
import { AssignRiderDto } from './dto/assign-rider.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller('admin')
export class AdminDeliveriesController {
  constructor(private readonly deliveriesService: DeliveriesService) {}

  @Post('orders/:id/assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign a rider to a confirmed order' })
  @ApiOkResponse({ description: 'The delivery assigned to the rider' })
  assign(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) orderId: string,
    @Body() dto: AssignRiderDto,
  ) {
    return this.deliveriesService.assignRider(admin, orderId, dto.riderId);
  }

  @Post('deliveries/:id/reassign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reassign an eligible delivery' })
  @ApiOkResponse({ description: 'The delivery assigned to the new rider' })
  reassign(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) deliveryId: string,
    @Body() dto: AssignRiderDto,
  ) {
    return this.deliveriesService.reassignDelivery(
      admin,
      deliveryId,
      dto.riderId,
    );
  }
}
