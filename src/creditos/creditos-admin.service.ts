import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { CreditosService } from './creditos.service';
import type { LancarCreditoDto } from './dto/lancar-credito.dto';
import type {
  ExtratoDeCreditoResponseDto,
  MovimentoCriadoResponseDto,
} from './dto/creditos-response.dto';

/**
 * SPEC-033/TASK-004 — o caminho do admin: lançar, retirar e ver o extrato.
 *
 * Separado do `CreditosService` de propósito. Aquele é o **mecanismo** do
 * ledger e é chamado de dentro de transações alheias (reserva, cancelamento);
 * este é o **caso de uso administrativo**, que abre a própria transação e
 * carrega o que só ele precisa — a senha e a ação administrativa. Juntar os
 * dois faria a criação de reserva depender de `bcrypt`.
 */
@Injectable()
export class CreditosAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly creditos: CreditosService,
  ) {}

  /**
   * AC-001 — lança ou retira, com senha reconferida no ato.
   *
   * ## A ordem das três coisas, e ela não é arbitrária
   *
   * 1. **senha primeiro, fora da transação.** O AC-002 exige que senha errada
   *    **não grave nada**; conferir antes de abrir a transação torna isso
   *    estrutural em vez de dependente de rollback. E `bcrypt.compare` custa
   *    ~100 ms — dentro da transação isso seria trava aberta à toa.
   * 2. **a ação administrativa**, dentro da transação, antes do movimento:
   *    `movimentos_acao_fkey` a exige, e ela é o gesto humano da SPEC-032.
   * 3. **o movimento**, que dispara a trigger do saldo.
   *
   * A trava de `alunos` mora no `CreditosService.retirar` (nível 2 da
   * INV-029). O lançamento não precisa dela: somar não pode deixar o saldo
   * negativo, então não há o que conferir antes.
   */
  async lancarOuRetirar(
    companyId: string,
    alunoId: string,
    autorId: string,
    dto: LancarCreditoDto,
  ): Promise<MovimentoCriadoResponseDto> {
    await this.exigirSenhaDoAutor(autorId, dto.senha);

    const movimentoId = await this.prisma.$transaction(async (tx) => {
      const acao = await tx.acaoAdministrativa.create({
        data: {
          companyId,
          tipo: dto.tipo === 'entrada' ? 'credito_lancado' : 'credito_retirado',
          autorId,
          motivo: dto.motivo,
        },
        select: { id: true },
      });
      const params = {
        companyId,
        alunoId,
        valorCentavos: dto.valorCentavos,
        motivo: dto.motivo,
        autorId,
        acaoId: acao.id,
      };
      return dto.tipo === 'entrada'
        ? this.creditos.lancar(tx, params)
        : this.creditos.retirar(tx, params);
    });

    return { movimentoId, saldoCentavos: await this.saldoDoAluno(alunoId) };
  }

  /**
   * O extrato do admin — **com `motivo`**, ao contrário do extrato do aluno.
   *
   * O AC-013 esconde o motivo do aluno porque é nota interna do clube
   * ("cheque devolvido") e o admin escreve com essa expectativa. Quem esconde
   * é a projeção da rota do aluno (TASK-006), não uma coluna diferente —
   * então este método **não** é reutilizável lá, e isso é intencional.
   */
  async extrato(
    companyId: string,
    alunoId: string,
  ): Promise<ExtratoDeCreditoResponseDto> {
    const aluno = await this.prisma.aluno.findFirst({
      where: { id: alunoId, companyId },
      select: { saldoCreditos: true },
    });
    if (!aluno) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'ALUNO_NAO_ENCONTRADO',
        message: 'Aluno não encontrado nesta empresa.',
      });
    }
    const movimentos = await this.prisma.movimentoDeCredito.findMany({
      where: { companyId, alunoId },
      orderBy: { criadoEm: 'desc' },
      select: {
        id: true,
        tipo: true,
        valorCentavos: true,
        motivo: true,
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
        motivo: m.motivo,
        ocupacaoId: m.ocupacaoId,
        criadoEm: m.criadoEm.toISOString(),
      })),
    };
  }

  /**
   * D6 / AC-002 — a senha do autor, reconferida.
   *
   * **`422`, nunca `401`** (PA-06): o `authFetch` dos frontends trata `401`
   * como sessão expirada e desloga. Deslogar o admin no meio de um lançamento
   * transforma erro de digitação em perda de contexto — e a decisão está
   * registrada porque a v1 desta spec dizia `401`.
   */
  private async exigirSenhaDoAutor(
    autorId: string,
    senha: string,
  ): Promise<void> {
    const autor = await this.prisma.usuario.findUnique({
      where: { id: autorId },
      select: { senhaHash: true },
    });
    const confere = autor
      ? await bcrypt.compare(senha, autor.senhaHash)
      : false;
    if (!confere) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'SENHA_INVALIDA',
        message: 'Senha incorreta.',
      });
    }
  }

  private async saldoDoAluno(alunoId: string): Promise<number> {
    const aluno = await this.prisma.aluno.findUnique({
      where: { id: alunoId },
      select: { saldoCreditos: true },
    });
    return aluno?.saldoCreditos ?? 0;
  }
}
