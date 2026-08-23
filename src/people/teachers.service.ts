import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import {
  gerarSenhaTemporaria,
  senhaTemporariaExpiraEm,
} from '../common/utils/senha-temporaria';
import type { CreateTeacherDto } from './dto/create-teacher.dto';
import type { PaginationQueryDto } from './dto/pagination-query.dto';
import type { UpdateTeacherDto } from './dto/update-teacher.dto';

@Injectable()
export class TeachersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(companyId: string, query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const [data, total] = await Promise.all([
      this.prisma.professor.findMany({
        where: { companyId },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.professor.count({ where: { companyId } }),
    ]);

    return { data, page, pageSize, total };
  }

  create(companyId: string, dto: CreateTeacherDto) {
    return this.prisma.professor.create({
      data: {
        companyId,
        nome: dto.nome,
        telefone: dto.telefone,
        email: dto.email,
      },
    });
  }

  async findOne(companyId: string, id: string) {
    const professor = await this.prisma.professor.findFirst({
      where: { id, companyId },
    });
    if (!professor) {
      throw new NotFoundException();
    }
    return professor;
  }

  async update(companyId: string, id: string, dto: UpdateTeacherDto) {
    const existente = await this.findOne(companyId, id);

    return this.prisma.$transaction(async (tx) => {
      // SPEC-013/INV-013 — a divida que a TASK-000 deixou anotada aqui.
      // `professores.status` e a ficha; quem manda no acesso e
      // `usuarios.status`. Enquanto o professor nao tinha conta isto era
      // inofensivo; agora que tem, nao propagar traria DEF-001 de volta
      // pela porta do professor. Mesma transacao, mesma regra dos alunos.
      if (dto.status !== undefined && existente.usuarioId) {
        await tx.usuario.update({
          where: { id: existente.usuarioId },
          data: { status: dto.status },
        });

        if (dto.status === 'inativo') {
          await tx.refreshToken.updateMany({
            where: { usuarioId: existente.usuarioId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }
      }

      return tx.professor.update({
        where: { id },
        data: {
          nome: dto.nome,
          telefone: dto.telefone,
          email: dto.email,
          status: dto.status,
        },
      });
    });
  }

  /**
   * SPEC-013/REQ — cria o acesso de um professor que ja existe como ficha.
   *
   * Reusa o desenho da SPEC-009 inteiro: senha temporaria legivel, validade
   * de 7 dias, INV-008 travando a conta ate a troca. Nao ha nada novo aqui
   * de proposito — um segundo mecanismo de primeiro acesso seria uma
   * segunda superficie para manter e para errar.
   *
   * Chamar duas vezes **rotaciona** a senha em vez de criar outra conta
   * (AC-003). E o caso real: o professor perdeu o papel onde anotou.
   */
  async gerarAcesso(companyId: string, id: string) {
    const professor = await this.findOne(companyId, id);

    if (!professor.email) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'EMAIL_OBRIGATORIO',
        message:
          'Preencha o e-mail do professor antes de gerar o acesso — ele é o login.',
      });
    }

    const senhaTemporaria = gerarSenhaTemporaria();
    const senhaHash = await bcrypt.hash(senhaTemporaria, 12);

    // Ja tem conta: rotaciona a senha e derruba as sessoes abertas. Quem
    // pediu senha nova espera que a antiga pare de valer.
    if (professor.usuarioId) {
      const usuarioId = professor.usuarioId;
      await this.prisma.$transaction(async (tx) => {
        await tx.usuario.update({
          where: { id: usuarioId },
          data: {
            senhaHash,
            senhaTemporaria: true,
            senhaTemporariaExpiraEm: senhaTemporariaExpiraEm(),
            status: 'ativo',
          },
        });
        await tx.refreshToken.updateMany({
          where: { usuarioId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      });

      return { ...professor, senhaTemporaria };
    }

    // AC-004 — o e-mail ja e de outra pessoa. Checado antes da transacao
    // para dar mensagem util, e de novo pelo UNIQUE do banco, que e quem
    // de fato garante sob concorrencia.
    const emailEmUso = await this.prisma.usuario.findUnique({
      where: { email: professor.email },
    });
    if (emailEmUso) {
      throw new ConflictException({
        statusCode: 409,
        code: 'EMAIL_EM_USO',
        message:
          'Este e-mail já pertence a outra conta. Uma pessoa não pode ter duas contas na plataforma (LIM-001).',
      });
    }

    const atualizado = await this.prisma.$transaction(async (tx) => {
      const usuario = await tx.usuario.create({
        data: {
          email: professor.email as string,
          senhaHash,
          nome: professor.nome,
          telefone: professor.telefone,
          role: 'professor',
          companyId,
          senhaTemporaria: true,
          senhaTemporariaExpiraEm: senhaTemporariaExpiraEm(),
        },
      });

      return tx.professor.update({
        where: { id },
        data: { usuarioId: usuario.id },
      });
    });

    return { ...atualizado, senhaTemporaria };
  }
}
