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
import { FotoDeProfessorService } from './foto-de-professor.service';
import type { CreateTeacherDto } from './dto/create-teacher.dto';
import type { PaginationQueryDto } from './dto/pagination-query.dto';
import type { UpdateTeacherDto } from './dto/update-teacher.dto';

/**
 * O que toda consulta de professor precisa trazer para a INV-034 poder ser
 * resolvida: a chave da ficha e a da conta, quando há conta.
 *
 * **Declarado uma vez e reusado em toda consulta**, porque uma consulta que
 * esquecesse o `include` não quebraria — devolveria `fotoDoUsuario: null` e
 * mostraria a foto da ficha por cima da que a pessoa escolheu. Falha
 * silenciosa, do tipo que só aparece na tela de alguém.
 */
const COM_FOTO_DA_CONTA = {
  usuario: { select: { fotoKey: true } },
} as const;

type ProfessorCru = {
  id: string;
  companyId: string;
  usuarioId: string | null;
  fotoKey: string | null;
  usuario?: { fotoKey: string | null } | null;
};

@Injectable()
export class TeachersService {
  constructor(
    private readonly prisma: PrismaService,
    // SPEC-018/TASK-004: única fonte da INV-034. Toda leitura de professor
    // passa por `resolver()` — a precedência entre a foto da conta e a da
    // ficha não se repete em lugar nenhum.
    private readonly fotos: FotoDeProfessorService,
  ) {}

  /**
   * **SPEC-018/TASK-004 — e este método existe por causa de um vazamento.**
   *
   * Antes dele, `list`/`findOne`/`update` devolviam a linha crua do Prisma.
   * Enquanto `professores.foto_key` era sempre nula isso não custava nada;
   * com a TASK-004 escrevendo nela, **a chave crua sairia na resposta** — e
   * montar URL a partir dela contornaria a conferência do `StorageService`
   * (INV-037).
   *
   * Então a chave sai e entra `fotoUrl`, já assinada e já resolvida pela
   * INV-034.
   */
  private async comFoto<T extends ProfessorCru>(professor: T) {
    const { fotoKey, usuario, ...resto } = professor;
    const { fotoUrl } = await this.fotos.resolver({
      id: professor.id,
      companyId: professor.companyId,
      usuarioId: professor.usuarioId,
      fotoKey: fotoKey ?? null,
      fotoDoUsuario: usuario?.fotoKey ?? null,
    });
    return { ...resto, fotoUrl };
  }

  async list(companyId: string, query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const [data, total] = await Promise.all([
      this.prisma.professor.findMany({
        where: { companyId },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: COM_FOTO_DA_CONTA,
      }),
      this.prisma.professor.count({ where: { companyId } }),
    ]);

    // `Promise.all` e não um `for`: assinar URL é conta local (HMAC), não
    // ida à rede, mas é assíncrona — em série, uma página de 20 viraria 20
    // esperas encadeadas por nada.
    return {
      data: await Promise.all(data.map((p) => this.comFoto(p))),
      page,
      pageSize,
      total,
    };
  }

  async create(companyId: string, dto: CreateTeacherDto) {
    const professor = await this.prisma.professor.create({
      data: {
        companyId,
        nome: dto.nome,
        telefone: dto.telefone,
        email: dto.email,
      },
      include: COM_FOTO_DA_CONTA,
    });
    // Recém-criado nunca tem foto, mas passa pelo mesmo caminho: uma resposta
    // com formato diferente das outras é o tipo de detalhe que o cliente
    // descobre em produção.
    return this.comFoto(professor);
  }

  async findOne(companyId: string, id: string) {
    return this.comFoto(await this.carregarCru(companyId, id));
  }

  /**
   * A linha **crua**, para quem precisa dos campos que a resposta não leva.
   *
   * `update` e `gerarAcesso` leem `usuarioId`, `email`, `nome` e
   * `telefone` para decidir o que fazer — e `comFoto` tira a chave e devolve
   * um objeto de resposta, não a linha. Separar os dois evita o erro de
   * alguém passar a usar o objeto de resposta como se fosse a linha.
   */
  private async carregarCru(companyId: string, id: string) {
    const professor = await this.prisma.professor.findFirst({
      where: { id, companyId },
      include: COM_FOTO_DA_CONTA,
    });
    if (!professor) {
      throw new NotFoundException();
    }
    return professor;
  }

  async update(companyId: string, id: string, dto: UpdateTeacherDto) {
    const existente = await this.carregarCru(companyId, id);

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
        include: COM_FOTO_DA_CONTA,
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
    const professor = await this.carregarCru(companyId, id);

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

      return { ...(await this.comFoto(professor)), senhaTemporaria };
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
        include: COM_FOTO_DA_CONTA,
        data: { usuarioId: usuario.id },
      });
    });

    return { ...(await this.comFoto(atualizado)), senhaTemporaria };
  }
}
