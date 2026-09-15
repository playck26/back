import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { agoraNoFusoDoClube } from './date-time.util';
import type {
  AdicionalDisponivelResponseDto,
  AdicionalEditadoResponseDto,
  AdicionalResponseDto,
  CriarAdicionalDto,
  EditarAdicionalDto,
  HorarioAcimaDoEstoqueDto,
} from './dto/adicionais.dto';
import {
  adicionalJaExiste,
  adicionalNaoEncontrado,
  tipoNaoEncontrado,
  traduzirRecusaDoCatalogo,
} from './recusas-do-catalogo';
import { agruparEmBlocos, type BlocoDeReserva } from './slots.util';

type Cliente = PrismaService | Prisma.TransactionClient;

const COM_TIPO = {
  id: true,
  tipoId: true,
  nome: true,
  preco: true,
  estoque: true,
  ativo: true,
  tipo: { select: { nome: true } },
} as const;

interface LinhaComTipo {
  id: string;
  tipoId: string;
  nome: string;
  preco: { toString(): string };
  estoque: number;
  ativo: boolean;
  tipo: { nome: string };
}

function paraResposta(l: LinhaComTipo): AdicionalResponseDto {
  return {
    id: l.id,
    tipoId: l.tipoId,
    tipoNome: l.tipo.nome,
    nome: l.nome,
    // `Decimal` vira `number` na borda, num lugar só (mesma razão da SPEC-047).
    preco: Number(l.preco.toString()),
    estoque: l.estoque,
    ativo: l.ativo,
  };
}

/**
 * SPEC-054 — o catálogo de adicionais: o que o clube aluga junto com a reserva.
 *
 * O estoque é **do clube**, não da quadra, e quem garante que nenhuma unidade é
 * vendida a mais é o **banco** (trigger `adicional_cabe_no_estoque`, INV-133).
 * Este serviço **informa** (`disponiveis`, `horariosAcimaDoEstoque`) com a
 * mesma conta que a trigger faz — e a tela não reserva nada com isso (LIM-054j).
 */
@Injectable()
export class AdicionaisService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(companyId: string): Promise<AdicionalResponseDto[]> {
    const linhas = await this.prisma.adicional.findMany({
      where: { companyId },
      orderBy: [{ tipo: { ordem: 'asc' } }, { nome: 'asc' }],
      select: COM_TIPO,
    });
    return linhas.map(paraResposta);
  }

  async criar(
    companyId: string,
    dto: CriarAdicionalDto,
  ): Promise<AdicionalResponseDto> {
    await this.exigirTipoDaEmpresa(companyId, dto.tipoId);
    await this.recusarNomeRepetido(companyId, dto.nome);
    try {
      const linha = await this.prisma.adicional.create({
        data: {
          id: randomUUID(),
          companyId,
          tipoId: dto.tipoId,
          nome: dto.nome,
          preco: dto.preco,
          estoque: dto.estoque,
        },
        select: COM_TIPO,
      });
      return paraResposta(linha);
    } catch (error) {
      return traduzirRecusaDoCatalogo(error, 'criar-adicional');
    }
  }

  /**
   * D4 — **o gestor mudando estoque trava só o nível 2b** (`adicionais`), e é o
   * mesmo `FOR UPDATE` que a trigger da reserva toma: uma reserva e uma
   * mudança de estoque do mesmo adicional se serializam, e a lista de
   * `horariosAcimaDoEstoque` é lida com o estoque novo já gravado, na mesma
   * transação.
   */
  async editar(
    companyId: string,
    id: string,
    dto: EditarAdicionalDto,
  ): Promise<AdicionalEditadoResponseDto> {
    await this.exigirDaEmpresa(companyId, id);
    if (dto.tipoId !== undefined) {
      await this.exigirTipoDaEmpresa(companyId, dto.tipoId);
    }
    if (dto.nome !== undefined) {
      await this.recusarNomeRepetido(companyId, dto.nome, id);
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM adicionais
           WHERE company_id = ${companyId}::uuid AND id = ${id}::uuid
             FOR UPDATE`;
        const linha = await tx.adicional.update({
          where: { id },
          data: {
            tipoId: dto.tipoId,
            nome: dto.nome,
            preco: dto.preco,
            estoque: dto.estoque,
            ativo: dto.ativo,
          },
          select: COM_TIPO,
        });
        return {
          ...paraResposta(linha),
          horariosAcimaDoEstoque: await this.horariosAcimaDoEstoque(
            tx,
            companyId,
            id,
            linha.estoque,
          ),
        };
      });
    } catch (error) {
      return traduzirRecusaDoCatalogo(error, 'editar-adicional');
    }
  }

  /**
   * D8 — os adicionais **ativos**, com `disponivel` = o **menor** saldo entre os
   * blocos do pedido. Um pedido de 9h e 15h vira duas reservas, e o adicional
   * vale para cada uma (D6): o que cabe no pedido é o que cabe no pior bloco.
   */
  async disponiveis(
    companyId: string,
    data: string,
    slots: string,
  ): Promise<AdicionalDisponivelResponseDto[]> {
    const blocos = agruparEmBlocos(
      slots.split(',').map((s) => {
        const [horaInicio, horaFim] = s.split('-');
        return { horaInicio, horaFim };
      }),
    );
    const ativos = await this.prisma.adicional.findMany({
      where: { companyId, ativo: true },
      orderBy: [{ tipo: { ordem: 'asc' } }, { nome: 'asc' }],
      select: COM_TIPO,
    });
    if (ativos.length === 0) {
      return [];
    }
    const saldos = await this.saldosNoPedido(
      this.prisma,
      companyId,
      ativos.map((a) => a.id),
      data,
      blocos,
    );
    return ativos.map((a) => ({
      id: a.id,
      tipoId: a.tipoId,
      tipoNome: a.tipo.nome,
      nome: a.nome,
      preco: Number(a.preco.toString()),
      disponivel: saldos.get(a.id) ?? 0,
    }));
  }

  /**
   * **A conta da trigger, do lado de fora:** `estoque` − soma das quantidades
   * dos itens em ocupações não canceladas cujo intervalo se sobrepõe ao do
   * bloco; o menor valor entre os blocos; nunca negativo (o estoque pode ter
   * sido baixado abaixo do reservado, D13).
   *
   * Pública porque a criação de reserva a usa para responder `disponivel`
   * DEPOIS do `ROLLBACK` da transação recusada (D7).
   */
  async saldosNoPedido(
    cliente: Cliente,
    companyId: string,
    adicionalIds: string[],
    data: string,
    blocos: BlocoDeReserva[],
  ): Promise<Map<string, number>> {
    const saldos = new Map<string, number>();
    for (const bloco of blocos) {
      const linhas = await cliente.$queryRaw<
        { id: string; disponivel: number }[]
      >`
        SELECT a.id::text AS id,
               (a.estoque - coalesce((
                  SELECT sum(i.quantidade)
                    FROM adicionais_da_ocupacao i
                    JOIN ocupacoes_quadra o
                      ON o.company_id = i.company_id AND o.id = i.ocupacao_id
                   WHERE i.adicional_id = a.id
                     AND o.status_pagamento <> 'cancelado'
                     AND tsrange(o.data + o.hora_inicio, o.data + o.hora_fim)
                      && tsrange(${data}::date + ${bloco.horaInicio}::time,
                                 ${data}::date + ${bloco.horaFim}::time)
               ), 0))::int AS disponivel
          FROM adicionais a
         WHERE a.company_id = ${companyId}::uuid
           AND a.id = ANY(${adicionalIds}::uuid[])`;
      for (const { id, disponivel } of linhas) {
        const atual = saldos.get(id);
        const saldo = Math.max(0, disponivel);
        saldos.set(id, atual === undefined ? saldo : Math.min(atual, saldo));
      }
    }
    return saldos;
  }

  /**
   * D13 — reservas **futuras** (pelo fim, no fuso do clube, como a SPEC-041),
   * não canceladas, com este adicional, em que a soma sobreposta passa do
   * estoque. As reservas não são tocadas: a lista existe para o gestor ver.
   */
  private async horariosAcimaDoEstoque(
    cliente: Cliente,
    companyId: string,
    adicionalId: string,
    estoque: number,
  ): Promise<HorarioAcimaDoEstoqueDto[]> {
    const { dia, minutos } = agoraNoFusoDoClube();
    const hoje = dia.toISOString().slice(0, 10);
    const agora = `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;
    return cliente.$queryRaw<HorarioAcimaDoEstoqueDto[]>`
      SELECT data, "horaInicio", "horaFim", reservado FROM (
        SELECT to_char(o.data, 'YYYY-MM-DD') AS data,
               to_char(o.hora_inicio, 'HH24:MI') AS "horaInicio",
               to_char(o.hora_fim, 'HH24:MI') AS "horaFim",
               o.data AS ordem_data, o.hora_inicio AS ordem_hora,
               (SELECT coalesce(sum(i2.quantidade), 0)
                  FROM adicionais_da_ocupacao i2
                  JOIN ocupacoes_quadra o2
                    ON o2.company_id = i2.company_id AND o2.id = i2.ocupacao_id
                 WHERE i2.adicional_id = i.adicional_id
                   AND o2.status_pagamento <> 'cancelado'
                   AND tsrange(o2.data + o2.hora_inicio, o2.data + o2.hora_fim)
                    && tsrange(o.data + o.hora_inicio, o.data + o.hora_fim))::int AS reservado
          FROM adicionais_da_ocupacao i
          JOIN ocupacoes_quadra o ON o.company_id = i.company_id AND o.id = i.ocupacao_id
         WHERE i.company_id = ${companyId}::uuid
           AND i.adicional_id = ${adicionalId}::uuid
           AND o.status_pagamento <> 'cancelado'
           AND (o.data > ${hoje}::date
                OR (o.data = ${hoje}::date AND o.hora_fim > ${agora}::time))
      ) acima
      WHERE reservado > ${estoque}
      ORDER BY ordem_data, ordem_hora`;
  }

  async recusarNomeRepetido(
    companyId: string,
    nome: string,
    exceto?: string,
  ): Promise<void> {
    const existente = await this.prisma.adicional.findFirst({
      where: {
        companyId,
        nome,
        ...(exceto === undefined ? {} : { id: { not: exceto } }),
      },
      select: { id: true },
    });
    if (existente) {
      throw adicionalJaExiste();
    }
  }

  async exigirTipoDaEmpresa(companyId: string, tipoId: string): Promise<void> {
    const tipo = await this.prisma.tipoDeAdicional.findFirst({
      where: { id: tipoId, companyId },
      select: { id: true },
    });
    if (!tipo) {
      throw tipoNaoEncontrado();
    }
  }

  private async exigirDaEmpresa(companyId: string, id: string): Promise<void> {
    const adicional = await this.prisma.adicional.findFirst({
      where: { id, companyId },
      select: { id: true },
    });
    if (!adicional) {
      throw adicionalNaoEncontrado();
    }
  }
}
