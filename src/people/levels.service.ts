import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { criarNiveisPadrao } from './nivel-efetivo';
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

    return this.prisma.nivel.create({
      data: { companyId, nome: dto.nome, ordem: dto.ordem },
    });
  }

  async findOne(companyId: string, id: string): Promise<NivelResponseDto> {
    const nivel = await this.prisma.nivel.findFirst({
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

    return this.prisma.nivel.update({
      where: { id },
      data: { nome: dto.nome, ordem: dto.ordem },
    });
  }

  async remove(companyId: string, id: string): Promise<void> {
    await this.findOne(companyId, id);

    const emUsoPorAluno = await this.prisma.aluno.count({
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
    const emUsoPorTurma = await this.prisma.turma.count({
      where: { nivelId: id, companyId },
    });
    if (emUsoPorTurma > 0) {
      throw new UnprocessableEntityException(
        'Nível em uso por turma(s) — não pode ser removido. Mude o nível ' +
          'dessas turmas antes (SPEC-075).',
      );
    }

    await this.prisma.nivel.delete({ where: { id } });
  }
}
