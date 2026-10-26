import { createHash, randomBytes } from 'node:crypto';
import { GoneException, Inject, Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { BCRYPT_COST } from '../common/utils/senha-temporaria';
import { LogoDaEmpresaService } from '../companies/logo-da-empresa.service';
import {
  CONFIGURACAO_DOS_MODELOS,
  type ConfiguracaoDosModelos,
} from '../email/email.config';
import {
  renderizarRedefinicaoDeSenha,
  VALIDADE_DA_REDEFINICAO_EM_MINUTOS,
  type DestinoDaRedefinicao,
} from '../email/modelos/redefinicao-de-senha';
import {
  PROVEDOR_DE_EMAIL,
  type ProvedorDeEmail,
} from '../email/provedor-de-email';
import { PrismaService } from '../prisma/prisma.service';
import { impressaoDaCredencial } from './acesso.service';
import {
  PAPEIS_DA_REDEFINICAO,
  type ContaDaRedefinicaoResponseDto,
  type PapelDaRedefinicao,
  type RedefinicaoPublicaResponseDto,
} from './dto/redefinicao.dto';

/**
 * SPEC-090 — **o "esqueci minha senha"**: pedir o link (D1, D3), ver as contas
 * dele (D4) e redefinir a senha de uma (D5).
 *
 * Mora no `AcessoModule`, ao lado do convite da SPEC-083, de quem reaproveita
 * a regra do token e a impressão da credencial. O `POST /auth/esqueci-senha`
 * também é servido daqui: o `AuthModule` importa o `PeopleModule`, que importa
 * este módulo, e o caminho de volta fecharia um ciclo.
 *
 * **Nada aqui recebe a requisição.** O link sai da configuração e do papel
 * (D6, INV-090d), e o token cru existe só em memória, entre a emissão e o
 * envio (INV-090g): no banco vai o sha256, e no log só ids e motivo.
 */

/**
 * D4 — **um corpo só para todos os motivos**, constante como o
 * `LINK_INVALIDO` da 083: formato inválido, hash inexistente, pedido usado,
 * expirado, nenhuma conta aceita, conta fora do pedido, impressão que não bate.
 * A página não vira oráculo de "por que o link morreu" (AC-011, S12).
 *
 * O `code` é o mesmo da 083 de propósito: para a tela, os dois são "link que
 * não vale mais". A mensagem é outra — o convite manda pedir ao clube; aqui,
 * pedir outro link.
 */
export const REDEFINICAO_INVALIDA = Object.freeze({
  statusCode: 410,
  code: 'LINK_INVALIDO',
  message: 'Este link não vale mais. Peça outro em "Esqueceu a senha?".',
});

function redefinicaoInvalida(): GoneException {
  return new GoneException(REDEFINICAO_INVALIDA);
}

/** 32 bytes em base64url, sem preenchimento: sempre 43 caracteres (083). */
const FORMATO_DO_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * D3, passo 3 — o teto por e-mail: 3 pedidos na última hora. **Só aplicação**
 * (LIM-090-02): duas requisições simultâneas podem fazer o quarto, e isso é
 * aceito — o teto protege a cota do Resend e a caixa da vítima, não é
 * invariante.
 */
export const TETO_DE_PEDIDOS_POR_HORA = 3;

/** Hex, como o convite: o hash é a chave de busca. */
function sha256(valor: string): string {
  return createHash('sha256').update(valor).digest('hex');
}

/**
 * D6 — o destino do link, pelo papel das contas do pedido.
 *
 * - uma conta de `company_admin` → o Admin;
 * - uma ou mais de `aluno`/`professor` → o Cliente;
 * - qualquer outra combinação → `null`, e **não emite**.
 *
 * Pelo State (fato 3, SPEC-086) a mistura não acontece: o banco proíbe gestor
 * e outra conta com o mesmo e-mail, e dois gestores com o mesmo e-mail. Ela só
 * aparece com escrita direta no banco (AC-009), e aí o link de qualquer um dos
 * dois apps levaria a pessoa a uma conta que aquele app não atende.
 */
export function destinoDoPedido(
  papeis: readonly string[],
): DestinoDaRedefinicao | null {
  if (papeis.length === 1 && papeis[0] === 'company_admin') {
    return 'admin';
  }
  if (
    papeis.length > 0 &&
    papeis.every((papel) => papel === 'aluno' || papel === 'professor')
  ) {
    return 'cliente';
  }
  return null;
}

/** D3, passo 1 — uma conta que entra no pedido, lida na transação dele. */
interface ContaDoPedido {
  usuario_id: string;
  company_id: string;
  role: string;
  senha_hash: string;
}

/** O pedido gravado, e o que atravessa o commit até o envio. */
interface PedidoParaEnviar {
  readonly pedidoId: string;
  /** Só em memória, até o envio (INV-090g). */
  readonly token: string;
  readonly destino: DestinoDaRedefinicao;
  readonly quantidadeDeContas: number;
}

/** D5, passo 2 — o dono, lido sob `FOR UPDATE`. */
interface UsuarioTravadoNaRedefinicao {
  senha_hash: string;
  status: string;
  /** Nulo só para quem não tem empresa, e esse não tem pedido (D7). */
  empresa_status: string | null;
}

/**
 * D4/D5 passo 3 — a conta ainda aceita este link? Conta ativa, empresa ativa e
 * a impressão igual à da senha atual. **`senha_temporaria` não entra** (I4):
 * ao contrário do convite, a conta com senha temporária pode redefinir.
 */
function contaAceitaOLink(
  conta: {
    status: string;
    senhaHash: string;
    empresaStatus: string | null;
  },
  impressao: string,
): boolean {
  return (
    conta.status === 'ativo' &&
    conta.empresaStatus === 'ativa' &&
    impressaoDaCredencial(conta.senhaHash) === impressao
  );
}

/** D4 — a ordem da lista: o nome do clube, e o id para desempatar. */
function porClubeEId(
  a: ContaDaRedefinicaoResponseDto,
  b: ContaDaRedefinicaoResponseDto,
): number {
  const nome = a.empresa.nome.localeCompare(b.empresa.nome, 'pt-BR');
  if (nome !== 0) return nome;
  return a.usuarioId < b.usuarioId ? -1 : a.usuarioId > b.usuarioId ? 1 : 0;
}

@Injectable()
export class RedefinicaoService {
  private readonly logger = new Logger('Redefinicao');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROVEDOR_DE_EMAIL) private readonly provedor: ProvedorDeEmail,
    @Inject(CONFIGURACAO_DOS_MODELOS)
    private readonly modelos: ConfiguracaoDosModelos,
    private readonly logos: LogoDaEmpresaService,
  ) {}

  // ==========================================================================
  // Pedir o link (D1, D3) — roda DEPOIS da resposta
  // ==========================================================================

  /**
   * D3 — quem entra no pedido, o teto, a transação e o envio.
   *
   * **O controller não espera por isto** (D1): a resposta `202` já saiu
   * quando a primeira consulta roda, e por isso nada daqui pode mudar o que a
   * pessoa vê. Não lança por regra: sem conta, acima do teto ou com papéis
   * misturados, simplesmente não grava nem envia. Uma exceção de verdade (o
   * banco fora) sobe para o `.catch` do controller.
   */
  async solicitar(email: string): Promise<void> {
    const pedido = await this.prisma.$transaction(async (tx) => {
      // Passo 1 — as contas, com a senha lida NESTA transação e sem trava
      // (passo 4). `senha_temporaria` não filtra (I4): conta com convite
      // pendente ou com senha temporária vencida entra. O `JOIN` é o
      // `company_id` não nulo, e o filtro do papel é o primeiro mecanismo da D7.
      const contas = await tx.$queryRaw<ContaDoPedido[]>`
        SELECT u.id AS usuario_id, u.company_id, u.role::text AS role,
               u.senha_hash
          FROM usuarios u
          JOIN empresas e ON e.id = u.company_id
         WHERE u.email = ${email}
           AND u.role IN ('aluno', 'professor', 'company_admin')
           AND u.status = 'ativo'
           AND e.status = 'ativa'
         ORDER BY u.id`;

      // Passo 2 — nenhuma conta: fim. Nada gravado, nada enviado.
      if (contas.length === 0) {
        return null;
      }

      // D6 — a mistura não emite.
      const destino = destinoDoPedido(contas.map((conta) => conta.role));
      if (destino === null) {
        // Sem e-mail, sem ids: o evento basta para alguém ir ao banco.
        this.logger.warn({ evento: 'redefinicao_papeis_misturados' });
        return null;
      }

      // Passo 3 — o teto, contado antes do INSERT e pelo relógio do banco, o
      // mesmo que grava `criado_em`.
      const [{ pedidos }] = await tx.$queryRaw<{ pedidos: number }[]>`
        SELECT count(*)::int AS pedidos
          FROM pedidos_de_redefinicao
         WHERE email = ${email}
           AND criado_em > now() - interval '1 hour'`;
      if (pedidos >= TETO_DE_PEDIDOS_POR_HORA) {
        return null;
      }

      // Passo 4 — o pedido e uma linha por conta. `expira_em` sai do mesmo
      // `now()` que `criado_em` (o da transação): exatamente 60 minutos.
      // **Pedidos anteriores não são tocados** (I7): emitir não escreve em
      // pedido nenhum além deste.
      const token = randomBytes(32).toString('base64url');
      const [{ id: pedidoId }] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO pedidos_de_redefinicao (email, token_hash, expira_em)
        VALUES (${email}, ${sha256(token)},
                now() + make_interval(mins => ${VALIDADE_DA_REDEFINICAO_EM_MINUTOS}::int))
        RETURNING id`;
      await tx.contaDaRedefinicao.createMany({
        data: contas.map((conta) => ({
          pedidoId,
          companyId: conta.company_id,
          usuarioId: conta.usuario_id,
          // Erro sempre para o lado fechado: se a senha mudar entre esta
          // leitura e o uso, a impressão não bate e o link morre para a conta.
          impressaoCredencial: impressaoDaCredencial(conta.senha_hash),
        })),
      });

      return {
        pedidoId,
        token,
        destino,
        quantidadeDeContas: contas.length,
      } satisfies PedidoParaEnviar;
    });

    if (pedido !== null) {
      await this.enviarDepoisDoCommit(email, pedido);
    }
  }

  /**
   * D3, passo 5 — **o envio, depois do commit, e o resultado gravado**, no
   * molde do `enviarDepoisDoCommit` do convite: enviado de dentro de uma
   * transação que depois desfaz, o e-mail levaria um link para um pedido que
   * não existe.
   */
  private async enviarDepoisDoCommit(
    para: string,
    pedido: PedidoParaEnviar,
  ): Promise<void> {
    const mensagem = renderizarRedefinicaoDeSenha(this.modelos, {
      pedidoId: pedido.pedidoId,
      token: pedido.token,
      para,
      destino: pedido.destino,
      quantidadeDeContas: pedido.quantidadeDeContas,
    });
    const resultado = await this.provedor.enviar(mensagem);

    await this.prisma.pedidoDeRedefinicao.updateMany({
      where: { id: pedido.pedidoId },
      data: resultado.ok
        ? { emailResultado: 'enviado', emailMotivo: null, emailEm: new Date() }
        : {
            emailResultado: 'falhou',
            emailMotivo: resultado.motivo,
            emailEm: new Date(),
          },
    });

    if (!resultado.ok) {
      // Só o id e o motivo. Nunca o e-mail pedido, o link ou o token
      // (INV-090g, AC-017).
      this.logger.warn({
        evento: 'redefinicao_nao_enviada',
        pedidoId: pedido.pedidoId,
        motivo: resultado.motivo,
      });
    }
  }

  // ==========================================================================
  // Ver as contas do link (D4)
  // ==========================================================================

  /**
   * D4 — **só as contas que ainda aceitam o link** (I8): a que não aceita
   * some, sem card bloqueado; sem nenhuma, o link inteiro é `410`. **Não
   * consome**: a página pode recarregar à vontade.
   */
  async consultar(token: string): Promise<RedefinicaoPublicaResponseDto> {
    if (!FORMATO_DO_TOKEN.test(token)) {
      throw redefinicaoInvalida();
    }
    const pedido = await this.prisma.pedidoDeRedefinicao.findUnique({
      where: { tokenHash: sha256(token) },
      select: {
        expiraEm: true,
        usadoEm: true,
        contas: {
          select: {
            usuarioId: true,
            impressaoCredencial: true,
            usuario: {
              select: {
                role: true,
                status: true,
                senhaHash: true,
                empresa: {
                  select: {
                    id: true,
                    nome: true,
                    status: true,
                    logoKey: true,
                    logoUrl: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (
      !pedido ||
      pedido.usadoEm !== null ||
      pedido.expiraEm.getTime() <= Date.now()
    ) {
      throw redefinicaoInvalida();
    }

    const contas: ContaDaRedefinicaoResponseDto[] = [];
    for (const conta of pedido.contas) {
      const { usuario } = conta;
      const empresa = usuario.empresa;
      if (
        empresa === null ||
        !PAPEIS_DA_REDEFINICAO.includes(usuario.role as PapelDaRedefinicao) ||
        !contaAceitaOLink(
          {
            status: usuario.status,
            senhaHash: usuario.senhaHash,
            empresaStatus: empresa.status,
          },
          conta.impressaoCredencial,
        )
      ) {
        continue;
      }
      contas.push({
        usuarioId: conta.usuarioId,
        papel: usuario.role as PapelDaRedefinicao,
        empresa: {
          nome: empresa.nome,
          logoUrl: this.logos.resolver(empresa).logoUrl,
        },
      });
    }
    if (contas.length === 0) {
      throw redefinicaoInvalida();
    }
    return { contas: contas.sort(porClubeEId) };
  }

  // ==========================================================================
  // Redefinir (D5)
  // ==========================================================================

  /**
   * D5 — **redefinir é uma transação, com o usuário travado primeiro.** Os
   * passos são os da spec, na ordem dela:
   *
   * 0. o formato do token e o bcrypt da senha nova, **antes** da transação —
   *    o bcrypt custa ~270 ms e não pode segurar a trava do usuário;
   * 1. o pedido pelo hash e a linha `(pedido, conta)`, sem trava — ausente é
   *    `410` (INV-090f: o link só redefine conta listada no pedido);
   * 2. `FOR UPDATE OF u` no dono — **é o que serializa o link com qualquer
   *    troca de senha** e com outro link para a mesma conta (AC-018 c, d);
   * 3. conta ativa, empresa ativa e a impressão, do que foi lido sob a trava;
   * 4. reivindicar o PEDIDO com o `UPDATE` condicional: 0 linhas é `410`
   *    (INV-090a) — e o link morre para todas as contas dele (I6);
   * 5. a senha nova; 6. derrubar as sessões **daquela** conta.
   *
   * **Ordem de travas: `usuarios` → `pedidos_de_redefinicao` →
   * `refresh_tokens`**, a mesma de todo caminho que escreve `refresh_tokens`
   * depois de tomar `usuarios` (D5).
   *
   * **Sem login automático:** a página manda para o login, pela razão da 083.
   */
  async redefinir(
    token: string,
    usuarioId: string,
    senha: string,
  ): Promise<void> {
    if (!FORMATO_DO_TOKEN.test(token)) {
      throw redefinicaoInvalida();
    }
    const senhaHash = await bcrypt.hash(senha, BCRYPT_COST);
    const tokenHash = sha256(token);

    await this.prisma.$transaction(async (tx) => {
      // Passo 1.
      const pedido = await tx.pedidoDeRedefinicao.findUnique({
        where: { tokenHash },
        select: { id: true },
      });
      if (!pedido) {
        throw redefinicaoInvalida();
      }
      const conta = await tx.contaDaRedefinicao.findUnique({
        where: { pedidoId_usuarioId: { pedidoId: pedido.id, usuarioId } },
        select: { impressaoCredencial: true },
      });
      if (!conta) {
        throw redefinicaoInvalida();
      }

      // Passo 2.
      const [usuario] = await tx.$queryRaw<UsuarioTravadoNaRedefinicao[]>`
        SELECT u.senha_hash, u.status::text AS status,
               e.status::text AS empresa_status
          FROM usuarios u
          LEFT JOIN empresas e ON e.id = u.company_id
         WHERE u.id = ${usuarioId}::uuid
           FOR UPDATE OF u`;

      // Passo 3.
      if (
        !usuario ||
        !contaAceitaOLink(
          {
            status: usuario.status,
            senhaHash: usuario.senha_hash,
            empresaStatus: usuario.empresa_status,
          },
          conta.impressaoCredencial,
        )
      ) {
        throw redefinicaoInvalida();
      }

      // Passo 4 — no PEDIDO, e não na conta (I6).
      const reivindicados = await tx.$executeRaw`
        UPDATE pedidos_de_redefinicao SET usado_em = now()
         WHERE id = ${pedido.id}::uuid
           AND usado_em IS NULL
           AND expira_em > now()`;
      if (reivindicados !== 1) {
        throw redefinicaoInvalida();
      }

      // Passo 5.
      await tx.usuario.update({
        where: { id: usuarioId },
        data: {
          senhaHash,
          senhaTemporaria: false,
          senhaTemporariaExpiraEm: null,
        },
      });

      // Passo 6 — por `usuario_id`, e nunca por e-mail: as outras contas do
      // mesmo e-mail continuam com as sessões delas (AC-012, S9).
      await tx.refreshToken.updateMany({
        where: { usuarioId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }
}
