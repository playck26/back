import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CriarTipoDeAdicionalDto,
  EditarTipoDeAdicionalDto,
  TipoDeAdicionalResponseDto,
} from './dto/adicionais.dto';
import {
  tipoEmUso,
  tipoJaExiste,
  tipoNaoEncontrado,
  traduzirRecusaDoCatalogo,
} from './recusas-do-catalogo';

const CAMPOS = { id: true, nome: true, ordem: true } as const;

/**
 * SPEC-054/D8 e D10 — o catálogo LIVRE de tipos de adicional ("Raquetes",
 * "Bolas"). O gestor dá nome; não inventa regra.
 *
 * **A conferência é da aplicação, e o banco é a rede.** Cada método confere
 * antes (e responde com o código) e, se a escrita for recusada mesmo assim — a
 * corrida entre a conferência e a escrita —, `traduzirRecusaDoCatalogo`
 * devolve a mesma resposta. As conferências são métodos próprios, e não
 * `private`, por uma razão só: a prova da recusa do banco (AC-004, AC-033)
 * grava a linha concorrente exatamente entre a conferência e a escrita.
 *
 * **O nome é comparado EXATO**, como o `UNIQUE (company_id, nome)` do banco:
 * uma conferência mais larga que a constraint recusaria o que o banco aceita, e
 * as duas barreiras deixariam de dizer a mesma coisa.
 */
@Injectable()
export class TiposDeAdicionalService {
  constructor(private readonly prisma: PrismaService) {}

  listar(companyId: string): Promise<TipoDeAdicionalResponseDto[]> {
    return this.prisma.tipoDeAdicional.findMany({
      where: { companyId },
      orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
      select: CAMPOS,
    });
  }

  async criar(
    companyId: string,
    dto: CriarTipoDeAdicionalDto,
  ): Promise<TipoDeAdicionalResponseDto> {
    await this.recusarNomeRepetido(companyId, dto.nome);
    try {
      return await this.prisma.tipoDeAdicional.create({
        data: {
          id: randomUUID(),
          companyId,
          nome: dto.nome,
          ordem: dto.ordem ?? 0,
        },
        select: CAMPOS,
      });
    } catch (error) {
      return traduzirRecusaDoCatalogo(error, 'criar-tipo');
    }
  }

  async renomear(
    companyId: string,
    id: string,
    dto: EditarTipoDeAdicionalDto,
  ): Promise<TipoDeAdicionalResponseDto> {
    await this.exigirDaEmpresa(companyId, id);
    if (dto.nome !== undefined) {
      await this.recusarNomeRepetido(companyId, dto.nome, id);
    }
    try {
      return await this.prisma.tipoDeAdicional.update({
        where: { id },
        data: { nome: dto.nome, ordem: dto.ordem },
        select: CAMPOS,
      });
    } catch (error) {
      return traduzirRecusaDoCatalogo(error, 'renomear-tipo');
    }
  }

  async apagar(companyId: string, id: string): Promise<void> {
    await this.exigirDaEmpresa(companyId, id);
    const emUso = await this.contarAdicionais(companyId, id);
    if (emUso > 0) {
      throw tipoEmUso(emUso);
    }
    try {
      await this.prisma.tipoDeAdicional.delete({ where: { id } });
    } catch (error) {
      // `23001` (FK `RESTRICT`): um adicional entrou entre a contagem e o
      // `DELETE`. A contagem da resposta é relida DEPOIS da recusa.
      await traduzirRecusaDoCatalogo(error, 'apagar-tipo', () =>
        this.contarAdicionais(companyId, id),
      );
    }
  }

  /** Quantos adicionais apontam para o tipo. É o que o `TIPO_EM_USO` conta. */
  contarAdicionais(companyId: string, tipoId: string): Promise<number> {
    return this.prisma.adicional.count({ where: { companyId, tipoId } });
  }

  async recusarNomeRepetido(
    companyId: string,
    nome: string,
    exceto?: string,
  ): Promise<void> {
    const existente = await this.prisma.tipoDeAdicional.findFirst({
      where: {
        companyId,
        nome,
        ...(exceto === undefined ? {} : { id: { not: exceto } }),
      },
      select: { id: true },
    });
    if (existente) {
      throw tipoJaExiste();
    }
  }

  /** 404 para o tipo que não existe e para o de outra empresa — os dois iguais. */
  async exigirDaEmpresa(companyId: string, id: string): Promise<void> {
    const tipo = await this.prisma.tipoDeAdicional.findFirst({
      where: { id, companyId },
      select: { id: true },
    });
    if (!tipo) {
      throw tipoNaoEncontrado();
    }
  }
}
