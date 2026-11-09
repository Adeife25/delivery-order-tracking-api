import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
import { DeliveriesService } from './deliveries.service';
import { FailDeliveryDto } from './dto/fail-delivery.dto';
import { ListDeliveriesQueryDto } from './dto/list-deliveries-query.dto';

@ApiTags('deliveries')
@ApiBearerAuth()
@Controller('deliveries')
export class DeliveriesController {
  constructor(private readonly deliveriesService: DeliveriesService) {}

  @Get('assigned')
  @Roles(UserRole.RIDER)
  @ApiOperation({ summary: "Retrieve the authenticated rider's deliveries" })
  @ApiOkResponse({ description: 'A paginated list of rider deliveries' })
  listAssigned(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListDeliveriesQueryDto,
  ) {
    return this.deliveriesService.listAssigned(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Retrieve an authorised delivery' })
  @ApiOkResponse({ description: 'The requested delivery' })
  getById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.deliveriesService.getById(user, id);
  }

  @Post(':id/accept')
  @Roles(UserRole.RIDER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept an assigned delivery' })
  @ApiOkResponse({ description: 'The accepted delivery' })
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.deliveriesService.accept(user, id);
  }

  @Post(':id/reject')
  @Roles(UserRole.RIDER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject an assigned delivery' })
  @ApiOkResponse({ description: 'The delivery returned for reassignment' })
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.deliveriesService.reject(user, id);
  }

  @Post(':id/pickup')
  @Roles(UserRole.RIDER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record package pickup' })
  @ApiOkResponse({ description: 'The picked-up delivery' })
  pickup(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.deliveriesService.pickup(user, id);
  }

  @Post(':id/start')
  @Roles(UserRole.RIDER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start an accepted delivery' })
  @ApiOkResponse({ description: 'The in-transit delivery' })
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.deliveriesService.start(user, id);
  }

  @Post(':id/complete')
  @Roles(UserRole.RIDER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a delivery as completed' })
  @ApiOkResponse({ description: 'The completed delivery' })
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.deliveriesService.complete(user, id);
  }

  @Post(':id/fail')
  @Roles(UserRole.RIDER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record a failed delivery' })
  @ApiOkResponse({ description: 'The failed delivery' })
  fail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FailDeliveryDto,
  ) {
    return this.deliveriesService.fail(user, id, dto);
  }
}
