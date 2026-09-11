import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FotoDeProfessorService } from './foto-de-professor.service';
import { PrecoDeAulaService } from './preco-de-aula.service';
import type { ProfessorParaAlunoResponseDto } from './dto/professor-para-aluno.dto';

/**
 * SPEC-047/REQ-002 — a lista de professores **do ponto de vista do aluno**.
 *
 * ## A regra do preço saiu daqui — e foi a condição que este docstring previu
 *
 * Este texto dizia, sobre a duplicação com o `createBooking`:
 *
 * > *"se uma terceira cópia aparecer, aí a extração passa a valer a pena"*
 *
 * Apareceu: o `HorariosDeAulaParticularService` precisa recusar o professor
 * sem preço **antes** de oferecer horário dele. A regra mora agora em
 * `PrecoDeAulaService.resolver`, e este serviço a chama.
 *
 * **A consulta continua sendo daqui**, e de propósito: lá é um professor
 * dentro de uma criação de reserva, aqui é a lista inteira com uma consulta de
 * config. O que não podia divergir era a linha do `??` — e é só ela que saiu.
 */
@Injectable()
export class ProfessoresParaAlunoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fotos: FotoDeProfessorService,
  ) {}

  async listarParaAluno(
    companyId: string,
  ): Promise<ProfessorParaAlunoResponseDto[]> {
    const [professores, config] = await Promise.all([
      this.prisma.professor.findMany({
        // AC-006 — professor inativo não aparece. Ele está fora de operação
        // (DEF-027), e `POST /bookings` o recusa com `PROFESSOR_INATIVO`:
        // oferecer o que a criação nega é perder a confiança de quem usa.
        where: { companyId, status: 'ativo' },
        select: {
          id: true,
          companyId: true,
          nome: true,
          precoAula: true,
          usuarioId: true,
          fotoKey: true,
          usuario: { select: { fotoKey: true } },
        },
        orderBy: { nome: 'asc' },
      }),
      this.prisma.configOperacaoEmpresa.findUnique({
        where: { companyId },
        select: { precoAulaPadrao: true },
      }),
    ]);

    const padrao = config?.precoAulaPadrao ?? null;

    // AC-005 — **o filtro vem antes da foto, e a ordem economiza trabalho**:
    // assinar URL de quem não vai aparecer é ida ao storage por nada.
    const comPreco = professores
      .map((p) => ({
        p,
        preco: PrecoDeAulaService.resolver(p.precoAula, padrao),
      }))
      .filter(
        (
          x,
        ): x is {
          p: (typeof professores)[0];
          preco: NonNullable<typeof x.preco>;
        } => x.preco != null,
      );

    return Promise.all(
      comPreco.map(async ({ p, preco }) => ({
        id: p.id,
        nome: p.nome,
        fotoUrl: (
          await this.fotos.resolver({
            id: p.id,
            companyId: p.companyId,
            usuarioId: p.usuarioId,
            fotoKey: p.fotoKey,
            fotoDoUsuario: p.usuario?.fotoKey ?? null,
          })
        ).fotoUrl,
        precoAula: preco,
      })),
    );
  }
}
