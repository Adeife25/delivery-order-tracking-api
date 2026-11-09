import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { ListRidersQueryDto } from './list-riders-query.dto';

export enum RiderPerformanceSort {
  TOTAL_ASSIGNMENTS = 'totalAssignments',
  COMPLETED = 'completed',
  FAILED = 'failed',
  COMPLETION_RATE = 'completionRate',
  AVERAGE_DELIVERY_MINUTES = 'averageDeliveryMinutes',
  LAST_DELIVERED_AT = 'lastDeliveredAt',
}

export enum SortOrder {
  ASC = 'asc',
  DESC = 'desc',
}

export class RiderPerformanceQueryDto extends ListRidersQueryDto {
  @ApiPropertyOptional({
    enum: RiderPerformanceSort,
    default: RiderPerformanceSort.COMPLETED,
  })
  @IsOptional()
  @IsEnum(RiderPerformanceSort)
  sort: RiderPerformanceSort = RiderPerformanceSort.COMPLETED;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.DESC })
  @IsOptional()
  @IsEnum(SortOrder)
  order: SortOrder = SortOrder.DESC;
}
