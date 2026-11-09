import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class VerifyPaymentDto {
  @ApiProperty({
    description: 'Provider transaction reference returned by Paystack',
    example: 'PAY-ORD20261030ABCDEF-1234ABCD',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  reference!: string;
}
