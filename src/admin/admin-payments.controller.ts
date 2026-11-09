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
import { ListAdminPaymentsQueryDto } from './dto/list-admin-payments-query.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller('admin')
export class AdminPaymentsController {
  constructor(private readonly adminService: AdminService) {}

  @Get('payments')
  @ApiOperation({ summary: 'List and filter payment records' })
  @ApiOkResponse({ description: 'A paginated list of payment records' })
  listPayments(@Query() query: ListAdminPaymentsQueryDto) {
    return this.adminService.listPayments(query);
  }
}
