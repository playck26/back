import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '@prisma/client';
import {
  type ConfigOperacaoComNomesResponseDto,
  type ConfigOperacaoResponseDto,
  type DefinirConfigOperacaoDto,
  type DefinirNomesDeTipoDto,
  NOMES_DE_TIPO_PADRAO,
} from './dto/config-operacao.dto';
import { traduzirRecusaDoCatalogo } from '../courts/recusas-do-catalogo';
import { prazoDe, type PrazoDeCancelamento } from './prazo-de-cancelamento';

/** O que a política precisa saber sobre a empresa, já em tipo soma. */
export interface PrazosDaEmpresa {
  readonly aula: PrazoDeCancelamento;
  readonly reserva: PrazoDeCancelamento;
}

const SEM_CONFIGURACAO: ConfigOperacaoComNomesResponseDto = {
  prazoCancelamentoAulaHoras: null,
  prazoCancelamentoReservaHoras: null,
  // SPEC-047 — nulo aqui significa "o clube nao vende aula particular pelo
  // app", e nao "de graca".
  precoAulaPadrao: null,
  // SPEC-054/D1 — sem configuracao, os nomes padrao, ja resolvidos.
  nomeTipoQuadra: NOMES_DE_TIPO_PADRAO.quadra,
  nomeTipoAula: NOMES_DE_TIPO_PADRAO.aula,
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
/**
 * SPEC-046/D6 — os padrões da reposição, num lugar só.
 *
 * **Dois por mês** porque reposição é exceção, não rotina: quem falta toda
 * semana não está faltando, está em outra turma. **Trinta dias** porque
 * crédito sem validade acumula, e um dia alguém aparece com dez.
 *
 * Os dois são ajustáveis por clube — estes são o ponto de partida de quem não
 * configurou nada.
 */
export const REPOSICAO_PADRAO = { porMes: 2, validadeDias: 30 } as const;

export type RegraDeReposicao = { porMes: number; validadeDias: number };

/**
 * SPEC-047 — `Decimal` do Prisma vira `number` na resposta.
 *
 * Sem isto o JSON sairia como string (`"150"`), e a tela faria `Number()` em
 * cima — conversao espalhada e como erro de fator 100 nasce. A coluna e
 * `Decimal(10,2)` em REAIS, e a carteira continua em centavos.
 */
function numeroOuNulo(v: { toString(): string } | null): number | null {
  return v == null ? null : Number(v);
}

@Injectable()
export class ConfigOperacaoService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Empresa sem linha devolve os dois `null` — **não `404`**. Ver o docstring
   * de `ConfigOperacaoResponseDto`.
   */
  async ler(companyId: string): Promise<ConfigOperacaoComNomesResponseDto> {
    const linha = await this.prisma.configOperacaoEmpresa.findUnique({
      where: { companyId },
      select: {
        prazoCancelamentoAulaHoras: true,
        prazoCancelamentoReservaHoras: true,
        precoAulaPadrao: true,
        nomeTipoQuadra: true,
        nomeTipoAula: true,
      },
    });
    return linha
      ? {
          ...linha,
          precoAulaPadrao: numeroOuNulo(linha.precoAulaPadrao),
          // SPEC-054/D8 — resolvidos aqui, num lugar so: nulo e o padrao.
          nomeTipoQuadra: linha.nomeTipoQuadra ?? NOMES_DE_TIPO_PADRAO.quadra,
          nomeTipoAula: linha.nomeTipoAula ?? NOMES_DE_TIPO_PADRAO.aula,
        }
      : SEM_CONFIGURACAO;
  }

  /**
   * SPEC-054/D8 — grava **so as duas colunas dos nomes**, e nunca os prazos nem
   * o preco (AC-006). O `update` enumera os dois campos; o `create` so preenche
   * os nomes, e os demais nascem nulos, que e o estado de quem nao configurou.
   *
   * `null` apaga o nome e volta ao padrao — por isso `?? null` nao existe aqui:
   * o DTO ja exige os dois campos, e `null` e o valor.
   */
  async gravarNomesDeTipo(
    companyId: string,
    dto: DefinirNomesDeTipoDto,
  ): Promise<ConfigOperacaoComNomesResponseDto> {
    const nomes = {
      nomeTipoQuadra: dto.nomeTipoQuadra,
      nomeTipoAula: dto.nomeTipoAula,
    };
    try {
      await this.prisma.configOperacaoEmpresa.upsert({
        where: { companyId },
        create: { companyId, ...nomes },
        update: nomes,
        select: { id: true },
      });
    } catch (error) {
      // `23514` do `CHECK` dos nomes -> `400 VALOR_INVALIDO` (D10).
      return traduzirRecusaDoCatalogo(error, 'nomes-de-tipo');
    }
    return this.ler(companyId);
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
      // **`?? null` e nao `?? undefined`:** o `PUT` e substituicao total (ver o
      // DTO), entao campo ausente APAGA o preco. Deixar `undefined` faria o
      // Prisma preservar o valor antigo, e "salvei sem o campo" viraria "o
      // preco continua la" — que e o oposto de substituicao.
      precoAulaPadrao: dto.precoAulaPadrao ?? null,
    };
    const linha = await this.prisma.configOperacaoEmpresa.upsert({
      where: { companyId },
      create: { companyId, ...valores },
      update: valores,
      select: {
        prazoCancelamentoAulaHoras: true,
        prazoCancelamentoReservaHoras: true,
        precoAulaPadrao: true,
      },
    });
    return { ...linha, precoAulaPadrao: numeroOuNulo(linha.precoAulaPadrao) };
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

  /**
   * SPEC-046/D6 — teto e validade da reposição.
   *
   * **Nulo é "usa o padrão", nunca zero**, e é a mesma armadilha que o
   * docstring desta classe descreve para os prazos: *"`prazo ?? 0` compila
   * neste projeto, e produziria prazo de zero horas, que é o oposto de sem
   * prazo"*. Teto zero seria "nenhuma reposição permitida" — o oposto de "o
   * clube não configurou".
   *
   * Por isso os padrões moram **aqui**, num lugar só, e não espalhados como
   * `?? 2` em cada chamada: dois lugares divergem no primeiro ajuste.
   */
  async reposicaoDaEmpresa(
    companyId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<RegraDeReposicao> {
    const cliente = tx ?? this.prisma;
    const linha = await cliente.configOperacaoEmpresa.findUnique({
      where: { companyId },
      select: { reposicoesPorMes: true, reposicaoValidadeDias: true },
    });
    return {
      porMes: linha?.reposicoesPorMes ?? REPOSICAO_PADRAO.porMes,
      validadeDias:
        linha?.reposicaoValidadeDias ?? REPOSICAO_PADRAO.validadeDias,
    };
  }
}
