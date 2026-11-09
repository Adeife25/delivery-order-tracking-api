import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { AdminService } from './admin.service';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller('admin')
export class AdminUsersController {
  constructor(private readonly adminService: AdminService) {}

  @Get('customers')
  @ApiOperation({ summary: 'List customer accounts' })
  @ApiOkResponse({ description: 'A paginated list of customer accounts' })
  listCustomers(@Query() query: ListCustomersQueryDto) {
    return this.adminService.listCustomers(query);
  }

  @Patch('users/:id/status')
  @ApiOperation({ summary: 'Activate or deactivate a customer or rider' })
  @ApiOkResponse({ description: 'The updated customer or rider account' })
  updateUserStatus(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.adminService.updateUserStatus(admin, id, dto.isActive);
  }
}
