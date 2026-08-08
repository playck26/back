import { ApiProperty } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';

export class AvailabilityQueryDto {
  @ApiProperty({ example: '2026-08-20' })
  @IsDateString()
  data!: string;
}
