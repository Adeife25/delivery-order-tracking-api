import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '../generated/prisma/enums';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { SubmitLocationDto } from './dto/submit-location.dto';
import { TrackingService } from './tracking.service';

@ApiTags('tracking')
@ApiBearerAuth()
@Controller('deliveries')
export class TrackingController {
  constructor(private readonly trackingService: TrackingService) {}

  @Post(':id/location')
  @Roles(UserRole.RIDER)
  @ApiOperation({ summary: 'Submit a location update for an active delivery' })
  @ApiCreatedResponse({ description: 'The recorded delivery location' })
  submitLocation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitLocationDto,
  ) {
    return this.trackingService.submitLocation(user, id, dto);
  }

  @Get(':id/tracking')
  @ApiOperation({ summary: 'Retrieve authorised delivery tracking data' })
  @ApiOkResponse({
    description: 'Delivery details, latest location, and recent history',
  })
  getTracking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.trackingService.getTracking(user, id);
  }
}
