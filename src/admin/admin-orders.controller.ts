import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '../generated/prisma/enums';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminService } from './admin.service';
import { ListAdminOrdersQueryDto } from './dto/list-admin-orders-query.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller('admin')
export class AdminOrdersController {
  constructor(private readonly adminService: AdminService) {}

  @Get('orders')
  @ApiOperation({ summary: 'List and filter customer orders' })
  @ApiOkResponse({ description: 'A paginated list of orders' })
  listOrders(@Query() query: ListAdminOrdersQueryDto) {
    return this.adminService.listOrders(query);
  }
}
