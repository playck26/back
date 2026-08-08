import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class UpdatePaymentStatusDto {
  @ApiProperty({ enum: ['pago', 'cancelado'] })
  @IsIn(['pago', 'cancelado'])
  status!: 'pago' | 'cancelado';
}
