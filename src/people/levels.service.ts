import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  conferirEdicaoDeNivel,
  criarNiveisPadrao,
  primeiroNivel,
  travarNivelDaEmpresa,
} from './nivel-efetivo';
import { NivelResponseDto } from './dto/people-response.dto';
import type { CreateLevelDto } from './dto/create-level.dto';
import type { UpdateLevelDto } from './dto/update-level.dto';

@Injectable()
export class LevelsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * SPEC-075/D7 — **o método público de MOD-003 que semeia os níveis padrão**
   * de uma empresa nova, na transação de quem a cria.
   *
   * Existe para MOD-002 não escrever em `niveis` (`TARGET_ARCHITECTURE.md`,
   * seção 5: "só MOD-003"). O molde é o `StudentsService.criarPerfilDeAluno`,
   * pelo qual MOD-001 provisiona aluno sem escrever em `alunos`. A lista mora
   * em `NIVEIS_PADRAO` (`nivel-efetivo.ts`), e não aqui.
   *
   * Sem a trava de nível da empresa (D13) de propósito: a empresa acabou de
   * nascer numa transação ainda não comitada — não tem aluno nem turma, e
   * ninguém mais a enxerga.
   */
  semearNiveisPadrao(
    tx: Prisma.TransactionClient,
    companyId: string,
  ): Promise<void> {
    return criarNiveisPadrao(tx, companyId);
  }

  list(companyId: string) {
    return this.prisma.nivel.findMany({
      where: { companyId },
      orderBy: { ordem: 'asc' },
    });
  }

  async create(
    companyId: string,
    dto: CreateLevelDto,
  ): Promise<NivelResponseDto> {
    const existente = await this.prisma.nivel.findUnique({
      where: { companyId_nome: { companyId, nome: dto.nome } },
    });
    if (existente) {
      throw new ConflictException('Já existe um nível com esse nome (AC-003)');
    }

    return this.gravarConferindoOPrimeiro(companyId, (tx) =>
      tx.nivel.create({
        data: { companyId, nome: dto.nome, ordem: dto.ordem },
      }),
    );
  }

  async findOne(
    companyId: string,
    id: string,
    db: Pick<Prisma.TransactionClient, 'nivel'> = this.prisma,
  ): Promise<NivelResponseDto> {
    const nivel = await db.nivel.findFirst({
      where: { id, companyId },
    });
    if (!nivel) {
      throw new NotFoundException();
    }
    return nivel;
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateLevelDto,
  ): Promise<NivelResponseDto> {
    await this.findOne(companyId, id);

    if (dto.nome) {
      const existente = await this.prisma.nivel.findUnique({
        where: { companyId_nome: { companyId, nome: dto.nome } },
      });
      if (existente && existente.id !== id) {
        throw new ConflictException(
          'Já existe um nível com esse nome (AC-003)',
        );
      }
    }

    return this.gravarConferindoOPrimeiro(companyId, (tx) =>
      tx.nivel.update({
        where: { id },
        data: { nome: dto.nome, ordem: dto.ordem },
      }),
    );
  }

  /**
   * SPEC-075/D12 (decisão 6) — **criar ou reordenar um nível pode mudar quem
   * é o primeiro**, e com ele o nível efetivo de todo aluno sem nível (D1). A
   * escrita não pode deixar um desses alunos fora do nível de uma turma em que
   * ele está. Numa transação, e comparando os pares dos alunos sem nível antes
   * e depois; a recusa desfaz a escrita.
   *
   * O `remove` não passa por aqui: com a FK `RESTRICT` (D9), nível usado por
   * turma não se apaga, e não há estado em que só a D12 o recusasse.
   */
  private gravarConferindoOPrimeiro(
    companyId: string,
    escrever: (tx: Prisma.TransactionClient) => Promise<NivelResponseDto>,
  ): Promise<NivelResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      // SPEC-075/D13 — a trava de nível da empresa, PRIMEIRA instrução.
      await travarNivelDaEmpresa(tx, companyId, 'escrita');
      const antigo = await primeiroNivel(tx, companyId);
      const r = await conferirEdicaoDeNivel(
        tx,
        companyId,
        { alunosSemNivel: true },
        { tipo: 'primeiro', primeiroAntigo: antigo?.nome ?? '' },
        () => escrever(tx),
      );
      if (r.recusa) throw new UnprocessableEntityException(r.recusa);
      return r.resultado;
    });
  }

  /**
   * SPEC-079/REQ-007 (decisões I4 e I5 do Israel) — **o clube nunca fica sem
   * nível**: toda turma tem nível, e um clube sem nenhum não conseguiria criar
   * turma. Apagar o último é recusado, com o texto aprovado.
   *
   * **Contar e apagar sob a trava de nível da empresa** (a da D13 da
   * SPEC-075), como primeira instrução: sem ela, dois gestores apagando os
   * dois últimos contariam 2 cada um, e os dois apagariam (AC-017).
   *
   * A recusa do último vem ANTES das de uso: se o último está em uso por
   * turma, "mude o nível dessas turmas" não tem saída — não há outro nível —,
   * e "crie outro antes" tem.
   */
  async remove(companyId: string, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await travarNivelDaEmpresa(tx, companyId, 'escrita');
      await this.findOne(companyId, id, tx);

      const doClube = await tx.nivel.count({ where: { companyId } });
      if (doClube <= 1) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          code: 'ULTIMO_NIVEL_DO_CLUBE',
          message:
            'O clube precisa de pelo menos um nível. Crie outro antes de apagar este.',
        });
      }

      await this.recusarSeEmUso(tx, companyId, id);
      await tx.nivel.delete({ where: { id } });
    });
  }

  private async recusarSeEmUso(
    tx: Prisma.TransactionClient,
    companyId: string,
    id: string,
  ): Promise<void> {
    const emUsoPorAluno = await tx.aluno.count({
      where: { nivelId: id },
    });
    if (emUsoPorAluno > 0) {
      throw new UnprocessableEntityException(
        'Nível em uso por aluno(s) — não pode ser removido (CON-003.6)',
      );
    }

    // SPEC-075/D9 (INV-075e) — **apagar um nível nunca abre uma turma
    // restrita.** Antes, a FK de `turmas` era `SET NULL`: apagar o nível
    // deixava a turma sem nível, e turma sem nível é de todos. Agora a FK é
    // `RESTRICT` e o banco recusa; esta conferência existe para a MENSAGEM —
    // o banco é a garantia, o serviço é a explicação.
    const emUsoPorTurma = await tx.turma.count({
      where: { nivelId: id, companyId },
    });
    if (emUsoPorTurma > 0) {
      throw new UnprocessableEntityException(
        'Nível em uso por turma(s) — não pode ser removido. Mude o nível ' +
          'dessas turmas antes (SPEC-075).',
      );
    }
  }
}
