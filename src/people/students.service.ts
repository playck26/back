import {
  gerarSenhaTemporaria,
  senhaTemporariaExpiraEm,
} from '../common/utils/senha-temporaria';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import type { Prisma, VinculoAluno } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateStudentDto } from './dto/create-student.dto';
import type { ListStudentsQueryDto } from './dto/list-students-query.dto';
import type { UpdateStudentDto } from './dto/update-student.dto';

const BCRYPT_COST = 12;

@Injectable()
export class StudentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * SPEC-009 — hash de senha com o custo bcrypt do projeto, exposto para
   * quem provisiona conta por outro caminho (MOD-001, aceite de convite).
   * Existe para o custo não ser redefinido em cada módulo e divergir sem
   * ninguém notar.
   */
  hashSenha(senha: string): Promise<string> {
    return bcrypt.hash(senha, BCRYPT_COST);
  }

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

  async list(companyId: string, query: ListStudentsQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    // SPEC-009/AC-015: `?vinculo=pendente` é a fila de aprovação do admin.
    const where = {
      companyId,
      ...(query.vinculo ? { vinculo: query.vinculo } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.aluno.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: { usuario: true },
      }),
      this.prisma.aluno.count({ where }),
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

    // SPEC-009/REQ-003 — até aqui o sistema gerava uma senha aleatória de
    // 24 bytes e **nunca a mostrava a ninguém**: o aluno nascia com uma
    // conta que ninguém conseguia usar. Agora a senha é legível, tem
    // validade, e volta **uma única vez** nesta resposta, para o admin
    // encaminhar (ADR-013). No banco continua só o hash.
    const senhaTemporaria = gerarSenhaTemporaria();
    const senhaHash = await bcrypt.hash(senhaTemporaria, BCRYPT_COST);

    const aluno = await this.prisma.$transaction(async (tx) => {
      const usuario = await tx.usuario.create({
        data: {
          email: dto.email,
          senhaHash,
          nome: dto.nome,
          telefone: dto.telefone,
          role: 'aluno',
          companyId,
          senhaTemporaria: true,
          senhaTemporariaExpiraEm: senhaTemporariaExpiraEm(),
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

    // AC-006/AC-007: `senhaTemporaria` sai daqui e **de mais nenhum lugar**
    // — `toResponse` (usado por list, findOne e update) não a conhece.
    return { ...this.toResponse(aluno), senhaTemporaria };
  }

  /**
   * SPEC-009/REQ-005 (AC-010, AC-011) — o admin gera uma senha nova para
   * um aluno.
   *
   * É o substituto oficial do "esqueci minha senha" enquanto não houver
   * e-mail transacional (GAP-004, ADR-013): quem perdeu a senha pede ao
   * admin, que gera outra e reencaminha.
   *
   * Revoga as sessões abertas junto. Se a senha anterior circulou por
   * WhatsApp e o motivo da regeneração for justamente suspeita de que ela
   * chegou a quem não devia, deixar as sessões antigas vivas anularia o
   * gesto.
   */
  async regenerarSenhaTemporaria(companyId: string, id: string) {
    const aluno = await this.prisma.aluno.findFirst({
      where: { id, companyId },
      include: { usuario: true },
    });
    if (!aluno) {
      throw new NotFoundException();
    }

    const senhaTemporaria = gerarSenhaTemporaria();
    const senhaHash = await bcrypt.hash(senhaTemporaria, BCRYPT_COST);

    await this.prisma.$transaction(async (tx) => {
      await tx.usuario.update({
        where: { id: aluno.usuarioId },
        data: {
          senhaHash,
          senhaTemporaria: true,
          senhaTemporariaExpiraEm: senhaTemporariaExpiraEm(),
        },
      });
      await tx.refreshToken.updateMany({
        where: { usuarioId: aluno.usuarioId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    return { ...this.toResponse(aluno), senhaTemporaria };
  }

  /**
   * SPEC-009/INV-010 — a trava de vínculo, em forma pura.
   *
   * Vive em MOD-003 (dono da tabela `alunos`) e é chamada por MOD-004 e
   * MOD-005 no momento da escrita. Se cada consumidor escrevesse a própria
   * comparação, a regra existiria em três lugares e divergiria no primeiro
   * ajuste — que é como invariante vira sugestão.
   */
  garantirVinculoAprovado(aluno: { vinculo: VinculoAluno }): void {
    if (aluno.vinculo === 'aprovado') {
      return;
    }
    throw new ForbiddenException({
      statusCode: 403,
      code: 'VINCULO_PENDENTE',
      message:
        aluno.vinculo === 'pendente'
          ? 'Cadastro ainda em análise pela empresa.'
          : 'Cadastro recusado pela empresa.',
    });
  }

  /**
   * Mesma trava, para quem ainda não carregou o aluno (MOD-005). Aceita um
   * `tx` para rodar dentro da transação de quem chama — checar vínculo
   * fora da transação que cria a reserva abriria janela entre a checagem e
   * a escrita.
   */
  async exigirVinculoAprovado(
    companyId: string,
    alunoId: string,
    tx: Pick<Prisma.TransactionClient, 'aluno'> = this.prisma,
  ): Promise<void> {
    const aluno = await tx.aluno.findFirst({
      where: { id: alunoId, companyId },
      select: { vinculo: true },
    });
    if (!aluno) {
      throw new NotFoundException('Aluno não encontrado');
    }
    this.garantirVinculoAprovado(aluno);
  }

  /**
   * SPEC-009/REQ-008 (AC-015, AC-016) — aprovar e recusar um cadastro.
   *
   * Transições permitidas: `pendente -> aprovado`, `pendente -> recusado`
   * e `recusado -> aprovado` (o admin mudou de ideia). **`aprovado ->
   * recusado` não existe aqui**: desligar um aluno que já opera é
   * `status = inativo`, operação diferente, com consequências diferentes
   * (ele tem histórico, reservas, turmas). Confundir as duas faria "recusar
   * cadastro" virar um jeito silencioso de desligar aluno ativo.
   */
  async decidirVinculo(
    companyId: string,
    id: string,
    decisao: 'aprovado' | 'recusado',
  ) {
    const aluno = await this.prisma.aluno.findFirst({
      where: { id, companyId },
      include: { usuario: true },
    });
    if (!aluno) {
      throw new NotFoundException();
    }

    // AC-015: idempotente — aprovar duas vezes não é erro nem no-op
    // silencioso, devolve o estado atual.
    if (aluno.vinculo === decisao) {
      return this.toResponse(aluno);
    }

    if (decisao === 'recusado') {
      if (aluno.vinculo === 'aprovado') {
        throw new ConflictException(
          'Aluno já aprovado não é recusado por este fluxo — use inativação (status).',
        );
      }

      // Por INV-010 um pendente não deveria ter reserva nem turma. Se
      // tiver, é inconsistência de dado ou de ordem de implantação: a
      // recusa para e mostra o que está pendurado, em vez de cancelar por
      // conta própria. Cancelar reserva muda a agenda da empresa e é ação
      // de MOD-005 — não pode ser efeito colateral escondido de um clique.
      const [ocupacoes, turmas] = await Promise.all([
        this.prisma.ocupacaoQuadra.count({ where: { alunoId: id } }),
        this.prisma.turmaAluno.count({ where: { alunoId: id } }),
      ]);
      if (ocupacoes > 0 || turmas > 0) {
        throw new ConflictException({
          message:
            'Aluno tem reservas ou turmas vinculadas — resolva antes de recusar o cadastro.',
          ocupacoes,
          turmas,
        });
      }
    }

    const atualizado = await this.prisma.aluno.update({
      where: { id },
      data: { vinculo: decisao },
      include: { usuario: true },
    });
    return this.toResponse(atualizado);
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

      // SPEC-013/DEF-001 (INV-013) — `alunos.status` é a ficha; quem manda
      // no acesso é `usuarios.status`. Enquanto os dois não andaram juntos,
      // inativar mudava o badge e não tirava ninguém de dentro: a pessoa
      // continuava entrando e continuava ocupando quadra. Na mesma
      // transação de propósito — meia inativação é pior que nenhuma,
      // porque o gestor acredita nela.
      if (dto.status !== undefined) {
        await tx.usuario.update({
          where: { id: existente.usuarioId },
          data: { status: dto.status },
        });

        // Só na inativação. Reativar devolve o direito de entrar, não as
        // sessões antigas.
        if (dto.status === 'inativo') {
          await tx.refreshToken.updateMany({
            where: { usuarioId: existente.usuarioId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }
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
