import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsPositive, IsString, MinLength } from 'class-validator';

export class CreateCourtDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  nome!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  esporte!: string;

  @ApiProperty()
  @IsNumber()
  @IsPositive()
  precoHora!: number;
}
