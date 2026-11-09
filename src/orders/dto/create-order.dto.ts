import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

function trim(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class CreateOrderDto {
  @ApiProperty({ example: '12 Marina Road, Lagos' })
  @Transform(({ value }) => trim(value))
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  pickupAddress: string;

  @ApiPropertyOptional({ example: 6.4531 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-90)
  @Max(90)
  pickupLatitude?: number;

  @ApiPropertyOptional({ example: 3.3881 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-180)
  @Max(180)
  pickupLongitude?: number;

  @ApiProperty({ example: '45 Adeola Odeku Street, Lagos' })
  @Transform(({ value }) => trim(value))
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  deliveryAddress: string;

  @ApiPropertyOptional({ example: 6.4281 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-90)
  @Max(90)
  deliveryLatitude?: number;

  @ApiPropertyOptional({ example: 3.4219 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-180)
  @Max(180)
  deliveryLongitude?: number;

  @ApiProperty({ example: 'Small sealed carton' })
  @Transform(({ value }) => trim(value))
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  packageDescription: string;

  @ApiPropertyOptional({ example: 'Call on arrival' })
  @IsOptional()
  @Transform(({ value }) => trim(value))
  @IsString()
  @MaxLength(1000)
  deliveryInstructions?: string;
}
