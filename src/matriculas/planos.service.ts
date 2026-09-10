import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CriarPlanoDto, AtualizarPlanoDto } from './dto/plano.dto';
import type { PlanoResponseDto } from './dto/plano-response.dto';

/**
 * SPEC-037/REQ-001 — os planos que o clube vende.
 *
 * ## O link de pagamento é RESOLVIDO na leitura (D6/AC-004)
 *
 * `link_pagamento_url` nulo significa **"herda da empresa"**, não "não tem" —
 * a mesma forma de `horarios_funcionamento`, onde `quadra_id IS NULL` é o
 * padrão do clube. A resposta traz o link já resolvido **e** um `herdado`,
 * porque a tela não deveria ter de saber que ausência significa herança
 * (mesma regra do AC-007 da SPEC-040).
 *
 * *Sem o `herdado`, o gestor não distinguiria "este plano tem link próprio"
 * de "este plano usa o do clube" — e editar o link da empresa mudaria planos
 * que ele achava configurados.*
 *
 * ## Não existe `DELETE`, e a ausência é a decisão (AC-003/INV-115)
 *
 * Plano já contratado carrega história: apagar quebraria a FK `RESTRICT` de
 * `matriculas` com `23503`, que vaza como `500`. E mesmo um plano nunca
 * contratado não ganha rota de exclusão — duas formas de "sumir com o plano"
 * fariam o gestor escolher entre elas sem saber a diferença. `ativo: false` é
 * a única, e ela nunca perde dado.
 */
@Injectable()
export class PlanosService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * O link da empresa, carregado **uma vez** por listagem.
   *
   * Uma consulta por plano seria N+1 dentro de uma leitura de tela — o mesmo
   * padrão que o DEF-013 baniu três vezes neste projeto, e que voltou pelo
   * caminho de escrita na terceira.
   */
  private async linkDaEmpresa(companyId: string): Promise<string | null> {
    const config = await this.prisma.configPagamentoEmpresa.findUnique({
      where: { companyId },
      select: { linkPagamentoUrl: true },
    });
    return config?.linkPagamentoUrl ?? null;
  }

  private paraResposta(
    plano: {
      id: string;
      nome: string;
      valorCentavos: number;
      prazoMeses: number;
      linkPagamentoUrl: string | null;
      ativo: boolean;
    },
    linkDaEmpresa: string | null,
  ): PlanoResponseDto {
    return {
      id: plano.id,
      nome: plano.nome,
      valorCentavos: plano.valorCentavos,
      prazoMeses: plano.prazoMeses,
      linkPagamentoUrl: plano.linkPagamentoUrl ?? linkDaEmpresa,
      // `true` só quando a herança de fato aconteceu. Plano sem link próprio
      // numa empresa sem link também vem `herdado: true` com `null` — e é a
      // verdade: ele herda o nada.
      linkHerdado: plano.linkPagamentoUrl === null,
      ativo: plano.ativo,
    };
  }

  async listar(
    companyId: string,
    apenasAtivos = false,
  ): Promise<PlanoResponseDto[]> {
    const [planos, link] = await Promise.all([
      this.prisma.plano.findMany({
        where: { companyId, ...(apenasAtivos ? { ativo: true } : {}) },
        orderBy: [{ ativo: 'desc' }, { valorCentavos: 'asc' }],
      }),
      this.linkDaEmpresa(companyId),
    ]);
    return planos.map((p) => this.paraResposta(p, link));
  }

  async criar(
    companyId: string,
    dto: CriarPlanoDto,
  ): Promise<PlanoResponseDto> {
    const [plano, link] = await Promise.all([
      this.prisma.plano.create({
        data: {
          companyId,
          nome: dto.nome,
          valorCentavos: dto.valorCentavos,
          prazoMeses: dto.prazoMeses,
          linkPagamentoUrl: dto.linkPagamentoUrl ?? null,
        },
      }),
      this.linkDaEmpresa(companyId),
    ]);
    return this.paraResposta(plano, link);
  }

  /**
   * **Editar o plano NÃO reescreve matrícula nenhuma** (D1).
   *
   * A matrícula congelou `valor_centavos` e `valor_de_tabela_centavos` no dia
   * da contratação — é o mesmo padrão de `ocupacoes_quadra.valor`, que a
   * SPEC-011 escolheu por esta razão exata. Mudar o preço aqui vale para quem
   * matricular a partir de agora, e não para quem já assinou.
   */
  async atualizar(
    companyId: string,
    id: string,
    dto: AtualizarPlanoDto,
  ): Promise<PlanoResponseDto> {
    const existente = await this.prisma.plano.findFirst({
      where: { id, companyId },
      select: { id: true },
    });
    if (!existente) throw new NotFoundException();

    const [plano, link] = await Promise.all([
      this.prisma.plano.update({
        where: { id },
        data: {
          nome: dto.nome,
          valorCentavos: dto.valorCentavos,
          prazoMeses: dto.prazoMeses,
          // `null` limpa o link próprio e devolve o plano à herança (D6);
          // `undefined` não mexe. O DTO recusa `''`, pelo mesmo motivo da
          // SPEC-036: duas formas de apagar é uma a mais.
          linkPagamentoUrl: dto.linkPagamentoUrl,
          ativo: dto.ativo,
        },
      }),
      this.linkDaEmpresa(companyId),
    ]);
    return this.paraResposta(plano, link);
  }
}
