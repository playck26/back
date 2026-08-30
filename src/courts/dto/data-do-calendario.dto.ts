import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  Matches,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { dataExiste } from '../date-time.util';

/**
 * DEF-020 / validação cruzada da SPEC-026, achado 4.
 *
 * Regex não sabe quantos dias tem cada mês: `3[01]` aceita `2026-04-31` e
 * `2026-02-30`. O `parseDateOnly` então **normaliza em silêncio** — 31 de
 * abril vira 1º de maio, 30 de fevereiro vira 2 de março — e a rota
 * responde `200` com as aulas de um dia que ninguém pediu.
 *
 * Responder certo para a pergunta errada é pior que responder `400`: quem
 * chamou não tem como saber que a resposta é de outro dia.
 */
@ValidatorConstraint({ name: 'dataDoCalendario', async: false })
export class DataDoCalendarioConstraint implements ValidatorConstraintInterface {
  validate(valor: unknown): boolean {
    return typeof valor === 'string' && dataExiste(valor);
  }

  defaultMessage(): string {
    return 'data deve ser um dia que existe no calendário (AAAA-MM-DD)';
  }
}

/**
 * **A data validada, e isto conserta um buraco pequeno de silêncio.**
 *
 * `parseDateOnly('banana')` monta um `Invalid Date`, o Prisma consulta com
 * ele e a resposta volta **vazia** — indistinguível de "não há nada nesse
 * dia". Aqui a entrada errada é `400`, que é o que ela é.
 *
 * **Mora em `courts/` de propósito.** Nasceu na SPEC-026, dentro de
 * `classes/`, e a agenda do gestor (que é de `courts/`) precisou dela no
 * DEF-020. Importar de `classes/` inverteria a direção dos módulos —
 * `classes` já depende de `courts`, nunca o contrário.
 */
export class DataDaAgendaParamDto {
  @ApiProperty({ example: '2026-09-01', description: 'AAAA-MM-DD' })
  @IsString()
  @Matches(/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, {
    message: 'data deve estar no formato AAAA-MM-DD, com ano entre 2000 e 2099',
  })
  // O regex garante a FORMA; o constraint garante que o dia EXISTE. Os dois
  // são necessários: `3[01]` não sabe quantos dias tem fevereiro.
  @Validate(DataDoCalendarioConstraint)
  data!: string;
}
