import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Max, Min } from 'class-validator';

export class SubmitLocationDto {
  @ApiProperty({ example: 6.524379, minimum: -90, maximum: 90 })
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-90)
  @Max(90)
  latitude!: number;

  @ApiProperty({ example: 3.379206, minimum: -180, maximum: 180 })
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-180)
  @Max(180)
  longitude!: number;
}
