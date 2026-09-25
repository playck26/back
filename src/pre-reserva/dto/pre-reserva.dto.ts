import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, Validate } from 'class-validator';
import { UuidNoCorpo } from '../../common/validation/uuid-no-corpo.decorator';
import { DataDoCalendarioConstraint } from '../../courts/dto/data-do-calendario.dto';

/**
 * A hora cheia — **a mesma regra do expediente** (`definir-horarios.dto.ts`),
 * porque o slot é de 1 hora e começa em hora cheia (SPEC-010). Repetida aqui
 * e não importada porque lá ela é `const` de arquivo; o teste de contrato que
 * recusa `10:30` é o que as mantém iguais.
 */
const HORA_CHEIA = /^([01]\d|2[0-3]):00$/;

/**
 * SPEC-074/TASK-002 — o corpo de `POST /me/pre-reservas`.
 *
 * **Só o INÍCIO do slot** (D1): o servidor deriva o fim, porque o slot tem a
 * duração que a grade diz (SPEC-010), e deixar o cliente escolher o tamanho
 * abriria pedido de aviso para um intervalo que a grade nunca oferece.
 *
 * O `alunoId` **não entra aqui**: sai do token, como na fila de espera — a
 * lição da SPEC-031/D19, *"o prefixo não é mecanismo"*, vale para o corpo.
 */
export class PedirPreReservaDto {
  @ApiProperty({ example: '5f7c1e2a-0000-4000-8000-000000000001' })
  @UuidNoCorpo()
  quadraId!: string;

  @ApiProperty({ example: '2026-10-02', description: 'AAAA-MM-DD' })
  @IsString()
  @Matches(/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, {
    message: 'data deve estar no formato AAAA-MM-DD, com ano entre 2000 e 2099',
  })
  // A forma pelo regex; que o dia EXISTE, pelo constraint — `3[01]` não sabe
  // quantos dias tem fevereiro (DEF-020).
  @Validate(DataDoCalendarioConstraint)
  data!: string;

  @ApiProperty({
    example: '19:00',
    description: 'O início do slot, em hora cheia. O fim é o servidor que diz.',
  })
  @IsString()
  @Matches(HORA_CHEIA, {
    message: 'horaInicio deve ser hora cheia (ex.: 19:00)',
  })
  horaInicio!: string;
}

/**
 * Um pedido de aviso, como a tela precisa dele.
 *
 * **Sem `inicio_em` e sem `verificada_em`** — são do servidor (D6, D7) — e
 * **sem nome de quadra**: a tela que lista os pedidos já tem a quadra, e o
 * aviso nunca leva o nome (INV-063a, LIM-074d).
 */
export class PreReservaResponseDto {
  @ApiProperty({ example: '5f7c1e2a-0000-4000-8000-000000000003' })
  id!: string;

  @ApiProperty({ example: '5f7c1e2a-0000-4000-8000-000000000001' })
  quadraId!: string;

  @ApiProperty({ example: '2026-10-02' })
  data!: string;

  @ApiProperty({ example: '19:00' })
  horaInicio!: string;

  @ApiProperty({ example: '20:00' })
  horaFim!: string;

  @ApiProperty({
    example: 'aguardando',
    description:
      'Nasce `aguardando`. Quem o muda para `avisada` é o varredor ' +
      '(SPEC-074/D3), nunca esta rota.',
  })
  estado!: string;

  @ApiProperty({ example: '2026-09-25T12:31:00.000Z' })
  criadaEm!: string;
}
