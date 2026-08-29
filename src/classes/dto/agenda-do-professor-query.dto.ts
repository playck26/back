import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

/**
 * SPEC-026 — a entrada das duas rotas do calendário do professor.
 *
 * **`mes` é obrigatório aqui**, ao contrário do `AgendaQueryDto` do gestor,
 * onde ele é opcional e o serviço assume o mês corrente. Assumir o mês
 * corrente significa decidir que dia é hoje no servidor — e o servidor roda
 * em UTC, o que é a armadilha documentada em `date-time.util.ts`. A tela sabe
 * qual mês está mostrando; que ela diga.
 */
export class AgendaDoProfessorQueryDto {
  @ApiProperty({ example: '2026-09', description: 'AAAA-MM' })
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'mes deve estar no formato AAAA-MM',
  })
  mes!: string;
}

/**
 * **A data validada, e isto conserta um buraco pequeno de silêncio.**
 *
 * A rota equivalente do gestor recebe `@Param('data') data: string` sem
 * validação. `parseDateOnly('banana')` monta um `Invalid Date`, o Prisma
 * consulta com ele e a resposta volta **vazia** — indistinguível de "não há
 * aula nesse dia". Aqui a entrada errada é `400`, que é o que ela é.
 */
export class DataDaAgendaParamDto {
  @ApiProperty({ example: '2026-09-01', description: 'AAAA-MM-DD' })
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, {
    message: 'data deve estar no formato AAAA-MM-DD',
  })
  data!: string;
}
