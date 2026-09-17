import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Validate } from 'class-validator';
import { DataDoCalendarioConstraint } from '../../courts/dto/data-do-calendario.dto';

/**
 * SPEC-057/TASK-002/D11 (card 5352) — **a janela por data das aulas do aluno.**
 *
 * ## Por que ela existe
 *
 * `GET /me/classes` devolve **só o futuro** (`data >= hoje`), e a vista de
 * semana do aluno navega para trás. O resultado hoje é sete travessões: a
 * semana passada vem vazia **por definição do contrato**, não por erro — e a
 * tela ainda precisa avisar isso, para a pessoa não achar que perdeu dado.
 *
 * O card pede *"clicar para semanas anteriores e ver as aulas que se
 * passaram"*. Isso não é trabalho de tela.
 *
 * ## O contrato, observável
 *
 * - `de` e `ate` são **dias do calendário no fuso do clube**, e **inclusivos**;
 * - vêm **juntos**: um sozinho é `400`. Meia janela é ambígua — "de 01/09"
 *   até quando? Até hoje? Até sempre? Adivinhar aqui seria escolher pelo
 *   cliente;
 * - o intervalo máximo é **90 dias**. Sem teto, um pedido de dois anos
 *   carrega o histórico inteiro de um aluno antigo numa tela de 390px;
 * - **ausentes, o comportamento é o de hoje**: do dia corrente em diante. É o
 *   que mantém o Cliente antigo funcionando enquanto o novo não sobe.
 *
 * ## Validação de DIA, não de string
 *
 * `@IsDateString()` aceita `2026-02-30` e `2026-09-10T12:00:00Z`, e o
 * `parseDateOnly` normalizaria em silêncio — a rota responderia `200` com uma
 * janela que ninguém pediu. É o DEF-020, e o projeto já tem o mecanismo.
 */
export class MinhasAulasQueryDto {
  @ApiPropertyOptional({ example: '2026-09-01', description: 'AAAA-MM-DD' })
  @IsOptional()
  @IsString()
  @Validate(DataDoCalendarioConstraint)
  de?: string;

  @ApiPropertyOptional({ example: '2026-09-07', description: 'AAAA-MM-DD' })
  @IsOptional()
  @IsString()
  @Validate(DataDoCalendarioConstraint)
  ate?: string;
}

/** O teto da janela, em dias. Ver a nota da classe. */
export const MAXIMO_DE_DIAS_DA_JANELA = 90;
