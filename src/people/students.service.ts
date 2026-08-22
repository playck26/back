import { randomBytes } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import type { Prisma, VinculoAluno } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateStudentDto } from './dto/create-student.dto';
import type { PaginationQueryDto } from './dto/pagination-query.dto';
import type { UpdateStudentDto } from './dto/update-student.dto';

const BCRYPT_COST = 12;

@Injectable()
export class StudentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * SPEC-009/REQ-007 — único ponto de escrita na tabela `alunos`.
   *
   * `TARGET_ARCHITECTURE.md` (ownership de dados) diz que `alunos` é de
   * MOD-003 e "só MOD-003" escreve nela, mas MOD-001 (`AuthService
   * .registerAluno`) vinha fazendo `tx.aluno.create` direto. É a mesma
   * classe de violação que a validação cruzada de 2026-08-07 corrigiu
   * entre MOD-006 e MOD-005, e a correção segue o mesmo padrão: um método
   * público aqui, chamado por quem precisa, em vez de acesso à tabela.
   *
   * Recebe o `tx` porque provisionar conta é uma operação só — `usuarios`
   * e `alunos` nascem juntos ou nenhum dos dois. Quem chama é dono da
   * transação; este método não abre a sua.
   *
   * `vinculo` é obrigatório de propósito: quem cria uma conta precisa
   * declarar se a empresa já reconhece essa pessoa (REQ-008). O default do
   * banco é `pendente` (fail-closed), mas depender de default silencioso é
   * o tipo de coisa que passa despercebida numa revisão.
   */
  async criarPerfilDeAluno(
    tx: Prisma.TransactionClient,
    dados: {
      usuarioId: string;
      companyId: string;
      nivelId?: string | null;
      vinculo: VinculoAluno;
    },
  ) {
    return tx.aluno.create({
      data: {
        usuarioId: dados.usuarioId,
        companyId: dados.companyId,
        nivelId: dados.nivelId ?? null,
        vinculo: dados.vinculo,
      },
      include: { usuario: true },
    });
  }

  async list(companyId: string, query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const [rows, total] = await Promise.all([
      this.prisma.aluno.findMany({
        where: { companyId },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: { usuario: true },
      }),
      this.prisma.aluno.count({ where: { companyId } }),
    ]);

    return {
      data: rows.map((aluno) => this.toResponse(aluno)),
      page,
      pageSize,
      total,
    };
  }

  async create(companyId: string, dto: CreateStudentDto) {
    const emailExistente = await this.prisma.usuario.findUnique({
      where: { email: dto.email },
    });
    if (emailExistente) {
      throw new ConflictException('Email já cadastrado');
    }

    if (dto.nivelId) {
      await this.assertNivelPertenceAEmpresa(companyId, dto.nivelId);
    }

    // Aluno cadastrado pelo admin não escolhe senha (CON-003.1 não recebe
    // esse campo) — geramos uma aleatória, nunca exposta/logada. O usuario
    // nasce funcional (pode ser resetado depois); não é um convite por
    // e-mail (fora do MVP, GAP-004).
    const senhaHash = await bcrypt.hash(
      randomBytes(24).toString('hex'),
      BCRYPT_COST,
    );

    const aluno = await this.prisma.$transaction(async (tx) => {
      const usuario = await tx.usuario.create({
        data: {
          email: dto.email,
          senhaHash,
          nome: dto.nome,
          telefone: dto.telefone,
          role: 'aluno',
          companyId,
        },
      });

      // Cadastro pelo admin (C3): a iniciativa é da empresa, então o
      // aluno já nasce aprovado (REQ-008/AC-014).
      return this.criarPerfilDeAluno(tx, {
        usuarioId: usuario.id,
        companyId,
        nivelId: dto.nivelId,
        vinculo: 'aprovado',
      });
    });

    return this.toResponse(aluno);
  }

  async findOne(companyId: string, id: string) {
    const aluno = await this.prisma.aluno.findFirst({
      where: { id, companyId },
      include: { usuario: true },
    });
    if (!aluno) {
      throw new NotFoundException();
    }
    return this.toResponse(aluno);
  }

  async update(companyId: string, id: string, dto: UpdateStudentDto) {
    const existente = await this.prisma.aluno.findFirst({
      where: { id, companyId },
    });
    if (!existente) {
      throw new NotFoundException();
    }

    if (dto.nivelId) {
      await this.assertNivelPertenceAEmpresa(companyId, dto.nivelId);
    }

    const aluno = await this.prisma.$transaction(async (tx) => {
      if (dto.nome !== undefined || dto.telefone !== undefined) {
        await tx.usuario.update({
          where: { id: existente.usuarioId },
          data: { nome: dto.nome, telefone: dto.telefone },
        });
      }

      return tx.aluno.update({
        where: { id },
        data: { nivelId: dto.nivelId, status: dto.status },
        include: { usuario: true },
      });
    });

    return this.toResponse(aluno);
  }

  private async assertNivelPertenceAEmpresa(
    companyId: string,
    nivelId: string,
  ): Promise<void> {
    const nivel = await this.prisma.nivel.findFirst({
      where: { id: nivelId, companyId },
    });
    if (!nivel) {
      throw new NotFoundException('Nível não encontrado');
    }
  }

  private toResponse(aluno: {
    id: string;
    nivelId: string | null;
    status: string;
    usuario: { nome: string; email: string; telefone: string | null };
  }) {
    return {
      id: aluno.id,
      nome: aluno.usuario.nome,
      email: aluno.usuario.email,
      telefone: aluno.usuario.telefone,
      nivelId: aluno.nivelId,
      status: aluno.status,
    };
  }
}
