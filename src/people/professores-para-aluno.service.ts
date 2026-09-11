import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FotoDeProfessorService } from './foto-de-professor.service';
import type { ProfessorParaAlunoResponseDto } from './dto/professor-para-aluno.dto';

/**
 * SPEC-047/REQ-002 — a lista de professores **do ponto de vista do aluno**.
 *
 * ## A resolução do preço é a mesma do `createBooking`, e isso é um risco
 *
 * `professor.precoAula ?? config.precoAulaPadrao` aparece aqui e lá. **Duas
 * cópias da mesma regra divergem no primeiro ajuste** — é a lição que o
 * `garantirVinculoAprovado` documenta desde a SPEC-009.
 *
 * Não vive num lugar só hoje porque a forma é diferente: lá é **um**
 * professor dentro de uma transação, aqui é a **lista** inteira com uma
 * consulta de config. Extrair agora criaria uma função que recebe `tx` ou não,
 * devolve um ou vários, e fica pior que as duas.
 *
 * **O que impede a divergência é a prova**: o db-spec afere que a lista e a
 * criação concordam sobre quem tem preço. Declarado, não escondido — e se uma
 * terceira cópia aparecer, aí a extração passa a valer a pena.
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
      .map((p) => ({ p, preco: p.precoAula ?? padrao }))
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
        precoAula: Number(preco),
      })),
    );
  }
}
