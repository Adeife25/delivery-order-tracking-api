import { ApiProperty } from '@nestjs/swagger';
import { IsObjectIdString } from '../../common/object-id';

export class AssignRiderDto {
  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  @IsObjectIdString()
  riderId: string;
}
