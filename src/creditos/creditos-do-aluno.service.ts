import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { ExtratoDoAlunoResponseDto } from './dto/creditos-response.dto';

/**
 * SPEC-033/TASK-006 — o extrato do aluno, e o que ele NÃO traz.
 *
 * **`motivo` fica de fora, e isso é decisão de produto (AC-013).** É nota
 * interna do clube — "cheque devolvido" —, e o admin escreve com essa
 * expectativa. Mostrar mudaria o que ele escreve, e o registro pioraria.
 *
 * A omissão está no `select`, não num `delete` depois de ler: campo que nunca
 * sai do banco não vaza por engano numa serialização futura.
 */
@Injectable()
export class CreditosDoAlunoService {
  constructor(private readonly prisma: PrismaService) {}

  async extratoDoAluno(
    companyId: string,
    usuarioId: string,
  ): Promise<ExtratoDoAlunoResponseDto> {
    const aluno = await this.prisma.aluno.findFirst({
      where: { usuarioId, companyId },
      select: { id: true, saldoCreditos: true },
    });
    // AC-012b (PA-09): usuário autenticado SEM linha de aluno recebe `404`,
    // não `200` com saldo zero. É o que toda rota `/me/` do projeto já faz —
    // e "zero" mentiria: não é que a carteira esteja vazia, é que ela não
    // existe.
    if (!aluno) {
      throw new NotFoundException();
    }

    const movimentos = await this.prisma.movimentoDeCredito.findMany({
      where: { companyId, alunoId: aluno.id },
      orderBy: { criadoEm: 'desc' },
      select: {
        id: true,
        tipo: true,
        valorCentavos: true,
        ocupacaoId: true,
        criadoEm: true,
      },
    });

    return {
      saldoCentavos: aluno.saldoCreditos,
      movimentos: movimentos.map((m) => ({
        id: m.id,
        tipo: m.tipo,
        valorCentavos: m.valorCentavos,
        ocupacaoId: m.ocupacaoId,
        criadoEm: m.criadoEm.toISOString(),
      })),
    };
  }
}
