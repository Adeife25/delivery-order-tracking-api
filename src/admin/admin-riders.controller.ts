import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '../generated/prisma/enums';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminService } from './admin.service';
import { ListRidersQueryDto } from './dto/list-riders-query.dto';
import { RiderPerformanceQueryDto } from './dto/rider-performance-query.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller('admin')
export class AdminRidersController {
  constructor(private readonly adminService: AdminService) {}

  @Get('riders')
  @ApiOperation({ summary: 'List rider accounts' })
  @ApiOkResponse({ description: 'A paginated list of rider accounts' })
  listRiders(@Query() query: ListRidersQueryDto) {
    return this.adminService.listRiders(query);
  }

  @Get('riders/performance')
  @ApiOperation({
    summary: 'List riders with delivery quality and performance metrics',
  })
  @ApiOkResponse({
    description: 'A paginated list of riders and their performance metrics',
  })
  listRiderPerformance(@Query() query: RiderPerformanceQueryDto) {
    return this.adminService.listRiderPerformance(query);
  }

  @Get('riders/:id/performance')
  @ApiOperation({ summary: 'Retrieve one rider performance profile' })
  @ApiOkResponse({
    description: 'The rider profile, performance metrics, and recent jobs',
  })
  getRiderPerformance(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.getRiderPerformance(id);
  }
}
