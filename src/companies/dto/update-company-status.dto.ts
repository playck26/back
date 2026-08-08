import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class UpdateCompanyStatusDto {
  @ApiProperty({ enum: ['ativa', 'inativa'] })
  @IsIn(['ativa', 'inativa'])
  status!: 'ativa' | 'inativa';
}
