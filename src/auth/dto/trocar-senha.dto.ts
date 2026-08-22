import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class TrocarSenhaDto {
  @ApiProperty({
    description:
      'Senha atual. Para quem está no primeiro acesso, é a senha temporária recebida do admin.',
  })
  @IsString()
  senhaAtual!: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  novaSenha!: string;
}
