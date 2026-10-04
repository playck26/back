import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import {
  hashDeSegredoDescartado,
  type ContaDoConvite,
} from '../acesso/acesso.service';
import { EMAIL_EM_USO } from '../acesso/traduzir-violacao-de-unicidade';
import { PrismaService } from '../prisma/prisma.service';
import {
  gerarSenhaTemporaria,
  senhaTemporariaExpiraEm,
} from '../common/utils/senha-temporaria';
import { FotoDeProfessorService } from './foto-de-professor.service';
import {
  ProfessorComSenhaTemporariaResponseDto,
  ProfessorPaginadoResponseDto,
  ProfessorResponseDto,
} from './dto/people-response.dto';
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
  /** SPEC-047 — `Decimal` do Prisma; vira `number` no `comFoto`. */
  precoAula?: { toString(): string } | null;
};

/**
 * SPEC-013/AC-002 — o e-mail da ficha é o login: sem ele não há conta. Vale
 * para o `gerarAcesso` e para o convite do professor sem conta (SPEC-083/D9).
 */
function exigirEmail(professor: { email: string | null }): string {
  if (!professor.email) {
    throw new BadRequestException({
      statusCode: 400,
      code: 'EMAIL_OBRIGATORIO',
      message:
        'Preencha o e-mail do professor antes de gerar o acesso — ele é o login.',
    });
  }
  return professor.email;
}

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
    const { fotoKey, usuario, precoAula, ...resto } = professor;
    const { fotoUrl } = await this.fotos.resolver({
      id: professor.id,
      companyId: professor.companyId,
      usuarioId: professor.usuarioId,
      fotoKey: fotoKey ?? null,
      fotoDoUsuario: usuario?.fotoKey ?? null,
    });
    // SPEC-047 — `precoAula` é `Decimal` no Prisma e sairia como **string**
    // no JSON. A tela faria `Number()` em cima, e conversão espalhada é como
    // erro de fator 100 nasce. Converte aqui, num lugar só, como o
    // `fotoUrl` já faz com a chave.
    return {
      ...resto,
      precoAula: precoAula == null ? null : Number(precoAula),
      fotoUrl,
    };
  }

  async list(
    companyId: string,
    query: PaginationQueryDto,
  ): Promise<ProfessorPaginadoResponseDto> {
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

  async create(
    companyId: string,
    dto: CreateTeacherDto,
  ): Promise<ProfessorResponseDto> {
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

  async findOne(companyId: string, id: string): Promise<ProfessorResponseDto> {
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

  async update(
    companyId: string,
    id: string,
    dto: UpdateTeacherDto,
  ): Promise<ProfessorResponseDto> {
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

      // DEF-014 (SPEC-021/TASK-005) — **`comFoto` também aqui.** Este
      // `return` devolvia a linha crua, com `fotoKey` e o `usuario`
      // aninhado que o `include` carrega. A SPEC-018/TASK-004 trocou
      // `list` e `findOne` por `comFoto` e passou reto por este; achou a
      // amarra de retorno desta spec, não uma pessoa.
      const atualizado = await tx.professor.update({
        where: { id },
        include: COM_FOTO_DA_CONTA,
        data: {
          nome: dto.nome,
          telefone: dto.telefone,
          email: dto.email,
          status: dto.status,
          // SPEC-047/AC-001 — **`undefined` não mexe, `null` APAGA**, e são
          // duas intenções diferentes que o Prisma já distingue. É o mesmo
          // desenho dos sete campos da SPEC-036, e é por isso que o DTO
          // precisa aceitar `null` explicitamente.
          precoAula: dto.precoAula,
        },
      });
      return this.comFoto(atualizado);
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
  async gerarAcesso(
    companyId: string,
    id: string,
  ): Promise<ProfessorComSenhaTemporariaResponseDto> {
    const professor = await this.carregarCru(companyId, id);
    const email = exigirEmail(professor);

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

    await this.recusarEmailEmUso(email);

    const { vinculado } = await this.prisma.$transaction((tx) =>
      this.criarContaNaTransacao(tx, companyId, professor, email, senhaHash),
    );

    return { ...(await this.comFoto(vinculado)), senhaTemporaria };
  }

  /**
   * SPEC-083/D9 — a conta do convite por e-mail, pela ficha do professor.
   *
   * Com conta, é ela, e o convite segue o caminho do aluno. **Sem conta,
   * devolve como criá-la**, e a criação roda dentro da transação da emissão
   * (`AcessoService.enviarParaConta`): conta, vínculo e convite entram juntos.
   *
   * É a conta do `gerarAcesso`, com papel, nome, telefone e e-mail da ficha e
   * as mesmas recusas, com uma diferença: o hash é de um segredo descartado,
   * e não de uma senha mostrada. Ninguém conhece a senha; a pessoa cria a sua
   * pelo link. O bcrypt roda aqui, **antes** de a transação abrir (D4).
   */
  async contaParaConvite(
    companyId: string,
    id: string,
  ): Promise<ContaDoConvite> {
    const professor = await this.carregarCru(companyId, id);
    if (professor.usuarioId) {
      return { usuarioId: professor.usuarioId };
    }

    const email = exigirEmail(professor);
    await this.recusarEmailEmUso(email);
    const senhaHash = await hashDeSegredoDescartado();

    return {
      criarConta: async (tx) =>
        (
          await this.criarContaNaTransacao(
            tx,
            companyId,
            professor,
            email,
            senhaHash,
          )
        ).usuarioId,
    };
  }

  /**
   * AC-004 (SPEC-013) — o e-mail já é de outra pessoa. Conferido antes da
   * transação para dar mensagem útil, e de novo pelo UNIQUE do banco, que é
   * quem de fato garante sob concorrência. O corpo é o mesmo que o tradutor
   * da SPEC-083 dá a quem perde a corrida no UNIQUE.
   */
  private async recusarEmailEmUso(email: string): Promise<void> {
    const emailEmUso = await this.prisma.usuario.findUnique({
      where: { email },
    });
    if (emailEmUso) {
      throw new ConflictException(EMAIL_EM_USO);
    }
  }

  /**
   * A conta do professor e o vínculo na ficha, **dentro da transação de quem
   * chama**: a do `gerarAcesso` e a da emissão do convite (SPEC-083). O hash
   * chega pronto, porque bcrypt não roda dentro de transação.
   *
   * Nasce com senha temporária e a validade de 7 dias nos dois casos: no
   * convite, a senha é a que ninguém conhece, e o link (ou uma senha
   * temporária gerada depois) a substitui.
   */
  private async criarContaNaTransacao(
    tx: Prisma.TransactionClient,
    companyId: string,
    professor: { id: string; nome: string; telefone: string | null },
    email: string,
    senhaHash: string,
  ) {
    const usuario = await tx.usuario.create({
      data: {
        email,
        senhaHash,
        nome: professor.nome,
        telefone: professor.telefone,
        role: 'professor',
        companyId,
        senhaTemporaria: true,
        senhaTemporariaExpiraEm: senhaTemporariaExpiraEm(),
      },
    });

    const vinculado = await tx.professor.update({
      where: { id: professor.id },
      include: COM_FOTO_DA_CONTA,
      data: { usuarioId: usuario.id },
    });
    return { usuarioId: usuario.id, vinculado };
  }
}
