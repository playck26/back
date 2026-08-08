import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDefined,
  IsEmail,
  IsOptional,
  IsString,
  IsUrl,
  MinLength,
  ValidateNested,
} from 'class-validator';

class AdminInicialDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  nome!: string;

  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  senha!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  telefone?: string;
}

export class CreateCompanyDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  nome!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  logoUrl?: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  esportes!: string[];

  // @IsDefined() é necessário além de @ValidateNested(): sem ele, um
  // corpo sem `adminInicial` passa pela validação (nested validators só
  // rodam se a propriedade estiver presente) e quebra dentro do service
  // com erro não tratado em vez de um 400 do ValidationPipe.
  @ApiProperty({ type: AdminInicialDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => AdminInicialDto)
  adminInicial!: AdminInicialDto;
}
