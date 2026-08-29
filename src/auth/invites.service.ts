import { createHash, randomBytes } from 'node:crypto';
import {
  GoneException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { registrarAceiteNoCadastro } from '../aceites/registrar-aceite-no-cadastro';
import { StudentsService } from '../people/students.service';
import { ConviteAceitoResponseDto } from './dto/auth-response.dto';
import type { AceitarConviteDto } from './dto/aceitar-convite.dto';
import type { CriarConviteDto } from './dto/criar-convite.dto';

const VALIDADE_MS = 7 * 24 * 60 * 60 * 1000;

// SPEC-009/REQ-011: falha pública é sempre a mesma, sem distinguir convite
// usado de expirado, nem e-mail livre de e-mail já cadastrado.
const CONVITE_INVALIDO = 'Convite inválido ou já utilizado.';
const CADASTRO_NAO_CONCLUIDO =
  'Não foi possível concluir o cadastro com esses dados.';

/**
 * SPEC-009/REQ-002 — convite de uso único.
 *
 * O token vive só no link que o admin encaminha. No banco fica `sha256` do
 * token, **determinístico** — e é essa a diferença que importa em relação
 * a `refresh_tokens`, que usa bcrypt: lá a linha é encontrada por `jti` e
 * o hash só é comparado depois; aqui o token **é** a chave de busca da
 * claim atômica, e bcrypt (com salt por hash) tornaria `WHERE token_hash =
 * ?` impossível. Com 256 bits de entropia, sha256 sem salt não é
 * força-bruta-vel, e vazamento do banco continua não permitindo aceitar
 * convite. (Achado NOVO-001 da 2ª validação cruzada.)
 */
@Injectable()
export class InvitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly students: StudentsService,
  ) {}

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async criar(companyId: string, criadoPorId: string, dto: CriarConviteDto) {
    if (dto.email) {
      const existente = await this.prisma.usuario.findUnique({
        where: { email: dto.email },
      });
      if (existente) {
        // Caminho autenticado: o admin tem contexto legítimo para saber
        // que aquele e-mail já existe (diferente da superfície pública,
        // REQ-011).
        throw new UnprocessableEntityException('Email já cadastrado');
      }
    }

    const token = randomBytes(32).toString('base64url');
    const convite = await this.prisma.conviteAluno.create({
      data: {
        companyId,
        criadoPorId,
        email: dto.email,
        nome: dto.nome,
        telefone: dto.telefone,
        nivelId: dto.nivelId,
        tokenHash: this.hash(token),
        expiraEm: new Date(Date.now() + VALIDADE_MS),
      },
    });

    // AC-003: o token sai daqui e de mais nenhum lugar — nem a listagem
    // nem a consulta pública o devolvem.
    return {
      id: convite.id,
      token,
      expiraEm: convite.expiraEm,
    };
  }

  /**
   * AC-024 — o que a tela pública do convite mostra: nome da empresa e o
   * nome que o admin preencheu. Nada além disso.
   */
  async consultarPublico(token: string) {
    const convite = await this.prisma.conviteAluno.findUnique({
      where: { tokenHash: this.hash(token) },
      include: {
        empresa: {
          select: { nome: true, status: true, contratoVersaoVigente: true },
        },
      },
    });

    if (!convite) {
      throw new NotFoundException(CONVITE_INVALIDO);
    }
    // AC-023: usado e expirado devolvem o mesmo 410 — quem tem o link não
    // descobre se outra pessoa já o usou.
    if (convite.usadoEm || convite.expiraEm.getTime() < Date.now()) {
      throw new GoneException(CONVITE_INVALIDO);
    }
    if (convite.empresa.status !== 'ativa') {
      throw new GoneException(CONVITE_INVALIDO);
    }

    // SPEC-024/REQ-007 — o contrato vai junto, para a pessoa ler ANTES de
    // criar a conta. Uma segunda requisicao abriria a janela em que ela le
    // um texto e aceita outro.
    const contrato =
      convite.empresa.contratoVersaoVigente === null
        ? null
        : await this.prisma.contratoDaEmpresa.findUnique({
            where: {
              companyId_versao: {
                companyId: convite.companyId,
                versao: convite.empresa.contratoVersaoVigente,
              },
            },
            select: { versao: true, texto: true },
          });

    return {
      empresa: { nome: convite.empresa.nome },
      nome: convite.nome,
      contrato,
    };
  }

  /**
   * AC-004/AC-005 e INV-009 — aceite com claim atômica.
   *
   * A ordem importa: **primeiro reivindica o convite, depois cria a
   * conta**. Um `SELECT ... IS NULL` seguido de `UPDATE` deixaria duas
   * requisições simultâneas lerem "não usado" sob READ COMMITTED e criarem
   * duas contas com o mesmo convite. O `updateMany` com
   * `usadoEm: null` no WHERE é uma escrita só: o Postgres serializa
   * UPDATEs concorrentes na mesma linha, e só uma requisição consegue
   * `count = 1`. Mesmo padrão que `AuthService.refresh` usa para rotação
   * de refresh token.
   *
   * Se a criação da conta falhar depois da claim, a transação inteira
   * volta atrás e o convite fica utilizável de novo — que é o desejado:
   * ninguém perde um convite por causa de um e-mail digitado errado.
   */
  async aceitar(dto: AceitarConviteDto): Promise<ConviteAceitoResponseDto> {
    const tokenHash = this.hash(dto.token);

    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.conviteAluno.updateMany({
        where: { tokenHash, usadoEm: null, expiraEm: { gt: new Date() } },
        data: { usadoEm: new Date() },
      });
      if (claim.count === 0) {
        throw new GoneException(CONVITE_INVALIDO);
      }

      const convite = await tx.conviteAluno.findUniqueOrThrow({
        where: { tokenHash },
        include: {
          empresa: { select: { status: true, contratoVersaoVigente: true } },
        },
      });
      if (convite.empresa.status !== 'ativa') {
        throw new GoneException(CONVITE_INVALIDO);
      }

      // O e-mail do convite manda: foi a empresa que decidiu quem está
      // sendo convidado. Sem e-mail no convite, quem aceita informa o seu.
      const email = convite.email ?? dto.email;
      const nome = convite.nome ?? dto.nome;
      if (!email || !nome) {
        throw new UnprocessableEntityException(CADASTRO_NAO_CONCLUIDO);
      }

      const jaExiste = await tx.usuario.findUnique({ where: { email } });
      if (jaExiste) {
        throw new UnprocessableEntityException(CADASTRO_NAO_CONCLUIDO);
      }

      const senhaHash = await this.students.hashSenha(dto.senha);
      const usuario = await tx.usuario.create({
        data: {
          email,
          senhaHash,
          nome,
          telefone: convite.telefone ?? dto.telefone,
          role: 'aluno',
          companyId: convite.companyId,
        },
      });

      // Convite é iniciativa da empresa: o aluno já nasce aprovado
      // (REQ-008/AC-014). E a senha é dele desde o primeiro minuto, então
      // não há senha temporária nem troca forçada neste caminho.
      await this.students.criarPerfilDeAluno(tx, {
        usuarioId: usuario.id,
        companyId: convite.companyId,
        nivelId: convite.nivelId,
        vinculo: 'aprovado',
      });

      // SPEC-024, duvida 2 da spec — **o aceite entra na MESMA transacao que
      // cria a conta.** Fora dela existiria uma janela em que a conta existe
      // sem aceite, e o portao mandaria a pessoa para a tela de aceite logo
      // depois de ela ter aceitado. Falha em qualquer um dos dois nao deixa
      // metade.
      //
      // As versoes vem do cliente e sao conferidas contra o vigente: aceitar
      // "o que estiver valendo" seria concordar com um texto que nao se viu.
      await registrarAceiteNoCadastro(tx, usuario.id, {
        termoLido: dto.termoVersao,
        contratoLido: dto.contratoVersao,
        contratoVigente: convite.empresa.contratoVersaoVigente ?? null,
      });

      return { usuario: { id: usuario.id, email: usuario.email, nome } };
    });
  }
}
