import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class AssignRiderDto {
  @ApiProperty({ example: '8f14e45f-ea4b-4c3d-9a7e-2b6f4c1d8e90' })
  @IsUUID()
  riderId: string;
}
