import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '@prisma/client';
import {
  type ConfigOperacaoResponseDto,
  type DefinirConfigOperacaoDto,
} from './dto/config-operacao.dto';
import { prazoDe, type PrazoDeCancelamento } from './prazo-de-cancelamento';

/** O que a política precisa saber sobre a empresa, já em tipo soma. */
export interface PrazosDaEmpresa {
  readonly aula: PrazoDeCancelamento;
  readonly reserva: PrazoDeCancelamento;
}

const SEM_CONFIGURACAO: ConfigOperacaoResponseDto = {
  prazoCancelamentoAulaHoras: null,
  prazoCancelamentoReservaHoras: null,
};

/**
 * SPEC-031/TASK-003 — a leitura e a escrita da configuração de operação.
 *
 * ## A fronteira entre `number | null` e o tipo soma mora aqui
 *
 * O banco guarda `integer NULL`; a política (`prazo-de-cancelamento.ts`) fala
 * em `PrazoDeCancelamento`. **A tradução acontece num lugar só** — em
 * `prazosDaEmpresa` —, e é por isso que ela não pode virar `?? 0` espalhado
 * pelos serviços: `prazo ?? 0` compila neste projeto, e produziria "prazo de
 * zero horas", que é o oposto de "sem prazo" para quem cancela às 17h uma
 * aula das 19h.
 */
@Injectable()
export class ConfigOperacaoService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Empresa sem linha devolve os dois `null` — **não `404`**. Ver o docstring
   * de `ConfigOperacaoResponseDto`.
   */
  async ler(companyId: string): Promise<ConfigOperacaoResponseDto> {
    const linha = await this.prisma.configOperacaoEmpresa.findUnique({
      where: { companyId },
      select: {
        prazoCancelamentoAulaHoras: true,
        prazoCancelamentoReservaHoras: true,
      },
    });
    return linha ?? SEM_CONFIGURACAO;
  }

  /**
   * `upsert` porque a primeira gravação de uma empresa cria a linha e as
   * demais a substituem — e `PUT` é substituição total (ver o DTO). O
   * `UNIQUE (company_id)` é o que torna isto seguro sob concorrência: dois
   * `PUT` simultâneos não produzem duas linhas.
   */
  async gravar(
    companyId: string,
    dto: DefinirConfigOperacaoDto,
  ): Promise<ConfigOperacaoResponseDto> {
    const valores = {
      prazoCancelamentoAulaHoras: dto.prazoCancelamentoAulaHoras,
      prazoCancelamentoReservaHoras: dto.prazoCancelamentoReservaHoras,
    };
    const linha = await this.prisma.configOperacaoEmpresa.upsert({
      where: { companyId },
      create: { companyId, ...valores },
      update: valores,
      select: {
        prazoCancelamentoAulaHoras: true,
        prazoCancelamentoReservaHoras: true,
      },
    });
    return linha;
  }

  /**
   * Os dois prazos em tipo soma, para a política consumir.
   *
   * Recebe `tx` opcional porque quem decide sobre cancelamento **já está
   * numa transação** com a linha da turma travada (D16), e ler a
   * configuração por outra conexão enquanto se segura um lock é o defeito que
   * a SPEC-034 pagou caro: com o pool cheio, cada transação espera por uma
   * conexão que só sai quando outra terminar. **Sem `FOR UPDATE`** — a
   * configuração é lida, não disputada (D16, passo 4).
   */
  async prazosDaEmpresa(
    companyId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<PrazosDaEmpresa> {
    const cliente = tx ?? this.prisma;
    const linha = await cliente.configOperacaoEmpresa.findUnique({
      where: { companyId },
      select: {
        prazoCancelamentoAulaHoras: true,
        prazoCancelamentoReservaHoras: true,
      },
    });
    return {
      aula: prazoDe(linha?.prazoCancelamentoAulaHoras ?? null),
      reserva: prazoDe(linha?.prazoCancelamentoReservaHoras ?? null),
    };
  }
}
