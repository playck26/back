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
 *
 * (DEF-020: o mês assumido do gestor não deixou de existir, mas passou a sair
 * de `mesCorrenteNoFusoDoClube()` — a decisão acima segue valendo para quem
 * pode simplesmente dizer qual mês quer.)
 */
export class AgendaDoProfessorQueryDto {
  /**
   * DEF-020 — o ano é `20\d{2}`, não `\d{4}`.
   *
   * Com `\d{4}` o valor `0001-01` passava, e `Date.UTC(1, 0, 1)` mapeia anos
   * de 0 a 99 para **1900+ano** — a consulta ia parar em 1901. Devolvia mês
   * vazio, sem quebrar nada, que é exatamente o tipo de erro que sobrevive
   * anos sem ninguém notar.
   */
  @ApiProperty({ example: '2026-09', description: 'AAAA-MM (ano 2000–2099)' })
  @IsString()
  @Matches(/^20\d{2}-(0[1-9]|1[0-2])$/, {
    message: 'mes deve estar no formato AAAA-MM, com ano entre 2000 e 2099',
  })
  mes!: string;
}

/**
 * `DataDaAgendaParamDto` **mudou de casa no DEF-020**, para
 * `courts/dto/data-do-calendario.dto.ts`.
 *
 * Ela nasceu aqui, na SPEC-026, e a agenda do gestor precisou da mesma
 * validação — mas o gestor é `courts/`, e importar de `classes/` inverteria
 * a direção dos módulos. Reexportada daqui para não quebrar quem já a
 * importava deste caminho.
 */
export {
  DataDaAgendaParamDto,
  DataDoCalendarioConstraint,
} from '../../courts/dto/data-do-calendario.dto';
