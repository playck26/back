import { createHash, randomBytes } from 'node:crypto';
import {
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { BCRYPT_COST } from '../common/utils/senha-temporaria';
import { traduzirViolacaoDeUnicidade } from './traduzir-violacao-de-unicidade';
import {
  CONFIGURACAO_DOS_MODELOS,
  type ConfiguracaoDosModelos,
} from '../email/email.config';
import {
  renderizarConviteDeAcesso,
  VALIDADE_DO_CONVITE_EM_DIAS,
} from '../email/modelos/convite-de-acesso';
import {
  MOTIVOS_DA_FALHA,
  PROVEDOR_DE_EMAIL,
  type MotivoDaFalha,
  type ProvedorDeEmail,
  type ResultadoDoEnvio,
} from '../email/provedor-de-email';
import { PrismaService } from '../prisma/prisma.service';

/**
 * SPEC-083/D12 — o `AcessoModule`: o link de ativação de ponta a ponta.
 * Emitir (ficha), consultar e ativar (rotas públicas) e a situação (ficha).
 *
 * Módulo próprio pelo motivo que a SPEC-051 já tinha dado: o `AuthModule`
 * importa o `PeopleModule`, e o `PeopleModule` precisa emitir convite. Daqui
 * para fora só se vai ao banco e ao `EmailModule` — nunca ao `PeopleModule`,
 * que importa este.
 */

/**
 * D7 — **um corpo só para os oito motivos**, e é constante de propósito: a
 * página não pode virar oráculo de "por que o link morreu" (usado? senha
 * trocada? conta desligada?). O teste compara o corpo byte a byte (AC-021),
 * e um objeto montado em cada `throw` divergiria na primeira revisão de texto.
 *
 * O texto é o da tela (D11): quem chega aqui por um link não tem o que fazer
 * além de pedir outro.
 */
export const LINK_INVALIDO = Object.freeze({
  statusCode: 410,
  code: 'LINK_INVALIDO',
  message: 'Este link não vale mais. Peça um novo convite ao seu clube.',
});

function linkInvalido(): GoneException {
  return new GoneException(LINK_INVALIDO);
}

/** 32 bytes em base64url, sem preenchimento: sempre 43 caracteres. */
const FORMATO_DO_TOKEN = /^[A-Za-z0-9_-]{43}$/;

const UM_DIA_MS = 24 * 60 * 60 * 1000;

/** Hex, como `convites_aluno` (SPEC-009): o hash é a chave de busca. */
function sha256(valor: string): string {
  return createHash('sha256').update(valor).digest('hex');
}

/**
 * INV-083c — **a impressão da credencial**: o sha256 de `usuarios.senha_hash`.
 *
 * Compara estado, e não caminho: qualquer escrita de senha (regenerar, gerar
 * acesso, trocar a `pck-`, um caminho que ainda não existe) troca o hash, e o
 * bcrypt tem salt — a impressão nunca volta a bater.
 */
export function impressaoDaCredencial(senhaHash: string): string {
  return sha256(senhaHash);
}

/** O que o banco guarda de um convite novo, mais o token cru, que não vai. */
export interface ConvitePreparado {
  /** Só em memória, até o envio (INV-083f). */
  readonly token: string;
  readonly tokenHash: string;
  readonly impressaoCredencial: string;
  readonly expiraEm: Date;
}

/**
 * D6 — prepara a linha de um convite, sem tocar o banco. **Pura de propósito:**
 * a importação (TASK-005, D3 passo 4) prepara as suas por aqui e grava no SQL
 * cru dela; a ficha grava pela API de modelo. Uma regra de token só para os
 * dois caminhos.
 *
 * A impressão tem de vir do `senha_hash` lido **sob a trava** de quem vai
 * gravar: lida antes, uma troca de senha no meio passaria despercebida.
 */
export function prepararConvite(
  usuario: { readonly senhaHash: string },
  agora: Date = new Date(),
): ConvitePreparado {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: sha256(token),
    impressaoCredencial: impressaoDaCredencial(usuario.senhaHash),
    expiraEm: new Date(
      agora.getTime() + VALIDADE_DO_CONVITE_EM_DIAS * UM_DIA_MS,
    ),
  };
}

/**
 * D9 — as seis situações. `sem_conta` é só do professor sem `usuarioId`; o
 * aluno sempre tem conta.
 */
export const SITUACOES_DO_CONVITE = [
  'ativado',
  'sem_conta',
  'nao_enviado',
  'enviado',
  'falhou',
  'expirado',
] as const;

export type SituacaoDoConvite = (typeof SITUACOES_DO_CONVITE)[number];

/**
 * O motivo da situação: os cinco da porta (D8) e o `sem_confirmacao`, que não
 * é gravado por ninguém — é a ausência de gravação, quando o processo cai
 * entre o commit e o `UPDATE` do resultado.
 */
export const MOTIVOS_DA_SITUACAO = [
  ...MOTIVOS_DA_FALHA,
  'sem_confirmacao',
] as const;

export type MotivoDaSituacao = (typeof MOTIVOS_DA_SITUACAO)[number];

export interface SituacaoDoConviteDeAcesso {
  readonly situacao: SituacaoDoConvite;
  /** O instante do envio (ou da tentativa) ou da ativação, quando houver. */
  readonly em: Date | null;
  readonly expiraEm: Date | null;
  readonly motivo: MotivoDaSituacao | null;
}

/** O convite VIVO (nem usado nem revogado), do jeito que a situação o lê. */
export interface ConviteVivo {
  readonly impressaoCredencial: string;
  readonly expiraEm: Date;
  readonly emailResultado: 'enviado' | 'falhou' | null;
  readonly emailMotivo: string | null;
  readonly emailEm: Date | null;
}

/**
 * D9 — a tabela da situação, em forma pura, na ordem em que a tabela se lê.
 *
 * **A impressão entra aqui também, e não só na ativação.** Um convite vivo
 * cuja impressão não bate é um link que a ativação recusaria (a senha mudou
 * depois da emissão): mostrá-lo como `enviado` faria o gestor esperar por um
 * link morto. Por isso ele conta como `nao_enviado`.
 */
export function derivarSituacao(
  usuario: {
    readonly senhaTemporaria: boolean;
    readonly senhaHash: string;
  } | null,
  vivo: ConviteVivo | null,
  ativadoEm: Date | null,
  agora: Date,
): SituacaoDoConviteDeAcesso {
  const nada = { em: null, expiraEm: null, motivo: null };
  if (usuario === null) {
    return { situacao: 'sem_conta', ...nada };
  }
  if (!usuario.senhaTemporaria) {
    // A ativação pelo link deixa `usado_em`; a troca da `pck-` não deixa
    // instante nenhum, e então `em` fica nulo.
    return { situacao: 'ativado', ...nada, em: ativadoEm };
  }
  if (
    vivo === null ||
    vivo.impressaoCredencial !== impressaoDaCredencial(usuario.senhaHash)
  ) {
    return { situacao: 'nao_enviado', ...nada };
  }
  if (vivo.expiraEm.getTime() <= agora.getTime()) {
    return {
      situacao: 'expirado',
      em: vivo.emailEm,
      expiraEm: vivo.expiraEm,
      motivo: null,
    };
  }
  if (vivo.emailResultado === 'enviado') {
    return {
      situacao: 'enviado',
      em: vivo.emailEm,
      expiraEm: vivo.expiraEm,
      motivo: null,
    };
  }
  if (vivo.emailResultado === 'falhou') {
    return {
      situacao: 'falhou',
      em: vivo.emailEm,
      expiraEm: vivo.expiraEm,
      // Dois lugares gravam a coluna, os dois com o vocabulário da porta
      // (`MotivoDaFalha`, D8): `enviarDepoisDoCommit`, aqui, no envio avulso
      // (ficha do aluno e do professor), e `enviarConvites`, em
      // `importacao-de-alunos.service.ts`, no lote da importação.
      motivo: vivo.emailMotivo as MotivoDaFalha,
    };
  }
  return {
    situacao: 'falhou',
    em: null,
    expiraEm: vivo.expiraEm,
    motivo: 'sem_confirmacao',
  };
}

/** "Maria  Souza" → "Maria". A tela pública não mostra o nome inteiro. */
export function primeiroNome(nome: string): string {
  return nome.trim().split(/\s+/)[0] ?? '';
}

/**
 * Um convite emitido e ainda não enviado: o que atravessa o commit até o
 * envio. **O token cru existe só aqui**, em memória (INV-083f).
 */
export interface ConviteParaEnviar {
  readonly conviteId: string;
  readonly usuarioId: string;
  readonly token: string;
  /** Sempre `usuarios.email` (D9). */
  readonly para: string;
  readonly nomeDoClube: string;
  readonly nomeDaPessoa: string;
}

/**
 * D4/D9 — **o hash de uma senha que ninguém conhece.** A conta convidada nasce
 * com `senha_temporaria = true` e este hash. O segredo são 32 bytes aleatórios
 * que existem só dentro desta função: não vão a banco, a log nem à resposta.
 * 256 bits não se quebram por força bruta, então a conta só entra pelo link,
 * ou por uma senha temporária que o gestor gere depois (e que troca o hash).
 *
 * Custa um bcrypt (~270 ms nesta máquina, State 3): **quem chama calcula antes
 * de abrir a transação** (D4), para o hash não segurar trava nenhuma.
 */
export function hashDeSegredoDescartado(): Promise<string> {
  return bcrypt.hash(randomBytes(32).toString('base64url'), BCRYPT_COST);
}

/**
 * D9 — de quem é a conta do convite que a ficha vai emitir.
 *
 * - `usuarioId`: a conta já existe (o aluno; o professor com conta).
 * - `criarConta`: o professor sem conta. A conta é criada **dentro** da
 *   transação da emissão, para conta, vínculo e convite entrarem juntos ou
 *   nada entrar. Quem a cria é o `TeachersService`, dono da regra do
 *   `gerarAcesso`: este módulo não importa o `PeopleModule` (D12), e uma
 *   segunda cópia da criação de conta divergiria na primeira revisão.
 *   Devolve o id da conta criada.
 */
export type ContaDoConvite =
  | { readonly usuarioId: string }
  | {
      readonly criarConta: (tx: Prisma.TransactionClient) => Promise<string>;
    };

/** O dono, lido sob `FOR UPDATE` na emissão (D9). */
interface UsuarioTravadoNaEmissao {
  id: string;
  email: string;
  nome: string;
  senha_hash: string;
  senha_temporaria: boolean;
  empresa_nome: string;
}

/** O dono, lido sob `FOR UPDATE` na ativação (D7 passo 2). */
interface UsuarioTravadoNaAtivacao {
  senha_hash: string;
  senha_temporaria: boolean;
  status: string;
  /** Nulo só para quem não tem empresa, e esse não tem convite (INV-083d). */
  empresa_status: string | null;
}

@Injectable()
export class AcessoService {
  private readonly logger = new Logger('Acesso');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROVEDOR_DE_EMAIL) private readonly provedor: ProvedorDeEmail,
    @Inject(CONFIGURACAO_DOS_MODELOS)
    private readonly modelos: ConfiguracaoDosModelos,
  ) {}

  /** Ver {@link prepararConvite}: exposto no serviço para a importação. */
  prepararConvite(usuario: { readonly senhaHash: string }): ConvitePreparado {
    return prepararConvite(usuario);
  }

  // ==========================================================================
  // Emitir — enviar e reenviar são o mesmo gesto (D9)
  // ==========================================================================

  /**
   * D9 — **a parte transacional da emissão**, para quem já tem uma transação
   * aberta: a ficha abre a sua em `emitirEEnviar`, e no professor sem conta a
   * mesma transação cria a conta e o vínculo antes de chegar aqui.
   *
   * O `FOR UPDATE` no usuário vem **primeiro**: é a mesma trava que a
   * ativação toma (D7 passo 2), e é ela que serializa ativar × reenviar. A
   * impressão sai do `senha_hash` lido sob ela.
   */
  async emitirNaTransacao(
    tx: Prisma.TransactionClient,
    dados: { companyId: string; usuarioId: string; criadoPorId: string },
  ): Promise<ConviteParaEnviar> {
    const [usuario] = await tx.$queryRaw<UsuarioTravadoNaEmissao[]>`
      SELECT u.id, u.email, u.nome, u.senha_hash, u.senha_temporaria,
             e.nome AS empresa_nome
        FROM usuarios u
        JOIN empresas e ON e.id = u.company_id
       WHERE u.id = ${dados.usuarioId}::uuid
         AND u.company_id = ${dados.companyId}::uuid
         FOR UPDATE OF u`;
    if (!usuario) {
      throw new NotFoundException();
    }

    // Mandar link que define a senha de quem já tem senha seria recuperação
    // de senha, e a I1 a deixou fora (é da SPEC-051).
    if (!usuario.senha_temporaria) {
      throw new ConflictException({
        statusCode: 409,
        code: 'CONTA_JA_ATIVADA',
        message:
          'Esta pessoa já criou a própria senha, e o convite não se aplica. Se ela perdeu a senha, gere uma senha temporária.',
      });
    }

    // O convite vivo morre aqui, expirado ou não: o índice parcial o conta
    // como vivo até ser revogado (D6), e com dois valendo um link "esquecido"
    // sobreviveria ao reenvio.
    await tx.conviteDeAcesso.updateMany({
      where: { usuarioId: usuario.id, usadoEm: null, revogadoEm: null },
      data: { revogadoEm: new Date() },
    });

    const preparado = prepararConvite({ senhaHash: usuario.senha_hash });
    const convite = await tx.conviteDeAcesso.create({
      data: {
        companyId: dados.companyId,
        usuarioId: usuario.id,
        criadoPorId: dados.criadoPorId,
        tokenHash: preparado.tokenHash,
        impressaoCredencial: preparado.impressaoCredencial,
        expiraEm: preparado.expiraEm,
      },
      select: { id: true },
    });

    return {
      conviteId: convite.id,
      usuarioId: usuario.id,
      token: preparado.token,
      para: usuario.email,
      nomeDoClube: usuario.empresa_nome,
      nomeDaPessoa: usuario.nome,
    };
  }

  /**
   * D8 — **o envio, depois do commit, e o resultado gravado.**
   *
   * Depois, e nunca dentro: um e-mail enviado de dentro de uma transação que
   * depois desfaz leva um link para um convite que não existe. Se o processo
   * cair entre o commit e o `UPDATE`, o convite fica sem resultado, e a ficha
   * mostra `falhou` com `sem_confirmacao`.
   *
   * O link sai da configuração (`montarLinkDeAtivacao`, dentro do modelo), e
   * nada daqui recebe a requisição (INV-083e).
   */
  async enviarDepoisDoCommit(
    convite: ConviteParaEnviar,
  ): Promise<ResultadoDoEnvio> {
    const mensagem = renderizarConviteDeAcesso(this.modelos, {
      conviteId: convite.conviteId,
      token: convite.token,
      para: convite.para,
      nomeDoClube: convite.nomeDoClube,
      nomeDaPessoa: convite.nomeDaPessoa,
    });
    const resultado = await this.provedor.enviar(mensagem);

    await this.prisma.conviteDeAcesso.updateMany({
      where: { id: convite.conviteId },
      data: resultado.ok
        ? { emailResultado: 'enviado', emailMotivo: null, emailEm: new Date() }
        : {
            emailResultado: 'falhou',
            emailMotivo: resultado.motivo,
            emailEm: new Date(),
          },
    });

    if (!resultado.ok) {
      // Só o id e o motivo. Nunca destinatário, link ou token (INV-083f).
      this.logger.warn({
        evento: 'convite_de_acesso_nao_enviado',
        conviteId: convite.conviteId,
        motivo: resultado.motivo,
      });
    }
    return resultado;
  }

  /**
   * D9 — **a emissão inteira da ficha**: a transação e o envio depois dela,
   * para os dois tipos de conta (`ContaDoConvite`). **Falha de e-mail não é
   * falha da rota** (AC-026): o convite fica gravado com `falhou`, e quem
   * chamou lê a situação.
   *
   * No professor sem conta, a conta nasce dentro da mesma transação, e quem
   * decide a corrida (dois envios para o mesmo professor, dois professores com
   * o mesmo e-mail) é o `UNIQUE` de `usuarios.email`: a perdedora recebe o
   * `P2002` e desfaz tudo, sem conta, vínculo ou convite pela metade.
   *
   * O tradutor da D9 é o único `catch` daqui: transforma as duas violações
   * que têm resposta (`EMAIL_EM_USO`, `CONVITE_EM_EMISSAO`) e deixa qualquer
   * outra subir como `500`.
   */
  private async emitirEEnviar(
    companyId: string,
    criadoPorId: string,
    conta: ContaDoConvite,
  ): Promise<{ usuarioId: string; resultado: ResultadoDoEnvio }> {
    let convite: ConviteParaEnviar;
    try {
      convite = await this.prisma.$transaction(async (tx) => {
        const usuarioId =
          'criarConta' in conta ? await conta.criarConta(tx) : conta.usuarioId;
        return this.emitirNaTransacao(tx, {
          companyId,
          usuarioId,
          criadoPorId,
        });
      });
    } catch (erro) {
      throw traduzirViolacaoDeUnicidade(erro);
    }
    return {
      usuarioId: convite.usuarioId,
      resultado: await this.enviarDepoisDoCommit(convite),
    };
  }

  /** D9 — emitir para uma conta que já existe (o caminho do aluno). */
  async emitirParaUsuario(
    companyId: string,
    usuarioId: string,
    criadoPorId: string,
  ): Promise<ResultadoDoEnvio> {
    return (await this.emitirEEnviar(companyId, criadoPorId, { usuarioId }))
      .resultado;
  }

  /**
   * D9 — o `POST` da ficha: emite, envia, e responde a situação já com o
   * resultado do envio. Serve ao aluno e ao professor, com ou sem conta.
   */
  async enviarParaConta(
    companyId: string,
    criadoPorId: string,
    conta: ContaDoConvite,
  ): Promise<SituacaoDoConviteDeAcesso> {
    const { usuarioId } = await this.emitirEEnviar(
      companyId,
      criadoPorId,
      conta,
    );
    return this.situacao(companyId, usuarioId);
  }

  // ==========================================================================
  // A situação (D9)
  // ==========================================================================

  /**
   * D9 — a situação do convite de uma conta. `usuarioId` nulo é o professor
   * sem conta (`sem_conta`); o aluno sempre tem.
   */
  async situacao(
    companyId: string,
    usuarioId: string | null,
  ): Promise<SituacaoDoConviteDeAcesso> {
    if (usuarioId === null) {
      return derivarSituacao(null, null, null, new Date());
    }
    const usuario = await this.prisma.usuario.findFirst({
      where: { id: usuarioId, companyId },
      select: { senhaTemporaria: true, senhaHash: true },
    });
    if (!usuario) {
      throw new NotFoundException();
    }

    if (!usuario.senhaTemporaria) {
      const usado = await this.prisma.conviteDeAcesso.findFirst({
        where: { usuarioId, usadoEm: { not: null } },
        orderBy: { usadoEm: 'desc' },
        select: { usadoEm: true },
      });
      return derivarSituacao(usuario, null, usado?.usadoEm ?? null, new Date());
    }

    // No máximo um: é o que o índice parcial garante (INV-083b).
    const vivo = await this.prisma.conviteDeAcesso.findFirst({
      where: { usuarioId, usadoEm: null, revogadoEm: null },
      select: {
        impressaoCredencial: true,
        expiraEm: true,
        emailResultado: true,
        emailMotivo: true,
        emailEm: true,
      },
    });
    return derivarSituacao(usuario, vivo, null, new Date());
  }

  // ==========================================================================
  // A ficha do aluno — o aluno é resolvido NA EMPRESA do gestor
  // ==========================================================================

  /**
   * `404` para aluno de outra empresa, como o resto da ficha: a rota não tem
   * `:companyId`, e o escopo vem do token (`CompanyAdminGuard`).
   */
  private async usuarioDoAluno(
    companyId: string,
    alunoId: string,
  ): Promise<string> {
    const aluno = await this.prisma.aluno.findFirst({
      where: { id: alunoId, companyId },
      select: { usuarioId: true },
    });
    if (!aluno) {
      throw new NotFoundException();
    }
    return aluno.usuarioId;
  }

  async situacaoDoAluno(
    companyId: string,
    alunoId: string,
  ): Promise<SituacaoDoConviteDeAcesso> {
    return this.situacao(
      companyId,
      await this.usuarioDoAluno(companyId, alunoId),
    );
  }

  /** O POST da ficha responde a situação depois do envio (D9). */
  async enviarParaAluno(
    companyId: string,
    alunoId: string,
    criadoPorId: string,
  ): Promise<SituacaoDoConviteDeAcesso> {
    const usuarioId = await this.usuarioDoAluno(companyId, alunoId);
    return this.enviarParaConta(companyId, criadoPorId, { usuarioId });
  }

  // ==========================================================================
  // A ficha do professor — o `POST` passa pelo `TeachersService`, que sabe
  // criar a conta de quem não tem (`ContaDoConvite`); o `GET` só lê.
  // ==========================================================================

  /**
   * `404` para professor de outra empresa, como o resto da ficha. Professor
   * sem `usuarioId` é `sem_conta` (D9).
   */
  async situacaoDoProfessor(
    companyId: string,
    professorId: string,
  ): Promise<SituacaoDoConviteDeAcesso> {
    const professor = await this.prisma.professor.findFirst({
      where: { id: professorId, companyId },
      select: { usuarioId: true },
    });
    if (!professor) {
      throw new NotFoundException();
    }
    return this.situacao(companyId, professor.usuarioId);
  }

  // ==========================================================================
  // As rotas públicas (D7)
  // ==========================================================================

  /**
   * D7 — o que a página do link mostra: o primeiro nome e o clube. **Não
   * consome**, e responde `410` nos mesmos oito casos em que a ativação
   * recusaria, para a página não mostrar formulário de um link morto.
   */
  async consultarPublico(
    token: string,
  ): Promise<{ primeiroNome: string; empresa: { nome: string } }> {
    if (!FORMATO_DO_TOKEN.test(token)) {
      throw linkInvalido();
    }
    const convite = await this.prisma.conviteDeAcesso.findUnique({
      where: { tokenHash: sha256(token) },
      select: {
        impressaoCredencial: true,
        expiraEm: true,
        usadoEm: true,
        revogadoEm: true,
        usuario: {
          select: {
            nome: true,
            senhaHash: true,
            senhaTemporaria: true,
            status: true,
            empresa: { select: { nome: true, status: true } },
          },
        },
      },
    });
    if (
      !convite ||
      convite.usadoEm !== null ||
      convite.revogadoEm !== null ||
      convite.expiraEm.getTime() <= Date.now() ||
      !this.contaAceitaOLink(
        {
          status: convite.usuario.status,
          senhaTemporaria: convite.usuario.senhaTemporaria,
          senhaHash: convite.usuario.senhaHash,
          empresaStatus: convite.usuario.empresa?.status ?? null,
        },
        convite.impressaoCredencial,
      )
    ) {
      throw linkInvalido();
    }
    return {
      primeiroNome: primeiroNome(convite.usuario.nome),
      empresa: { nome: convite.usuario.empresa?.nome ?? '' },
    };
  }

  /**
   * D7 — **ativar é uma transação, com o usuário travado primeiro.** Os
   * passos são os da spec, na ordem dela:
   *
   * 0. o bcrypt da senha nova, **antes** de abrir a transação — custa ~270 ms
   *    e não pode segurar a trava do usuário;
   * 1. localizar pelo hash, sem trava;
   * 2. `FOR UPDATE` no dono — **é a única coisa que serializa ativar ×
   *    regenerar** (sem ela, a ativação lê a senha antiga, a regeneração
   *    grava, e a senha do link entra por cima);
   * 3. conferir conta ativa, senha temporária, empresa ativa e a impressão,
   *    tudo do que foi lido sob a trava;
   * 4. reivindicar com o `UPDATE` condicional: 0 linhas é `410` (INV-083a);
   * 5. a senha nova; 6. derrubar as sessões.
   *
   * **Sem login automático:** a página manda para o login (D11). Emitir sessão
   * numa rota pública seria uma segunda forma de autenticação, com as regras
   * do login para replicar. O aceite acontece no portão do primeiro login.
   */
  async ativar(token: string, senha: string): Promise<void> {
    if (!FORMATO_DO_TOKEN.test(token)) {
      throw linkInvalido();
    }
    const senhaHash = await bcrypt.hash(senha, BCRYPT_COST);
    const tokenHash = sha256(token);

    await this.prisma.$transaction(async (tx) => {
      const convite = await tx.conviteDeAcesso.findUnique({
        where: { tokenHash },
        select: { id: true, usuarioId: true, impressaoCredencial: true },
      });
      if (!convite) {
        throw linkInvalido();
      }

      const [usuario] = await tx.$queryRaw<UsuarioTravadoNaAtivacao[]>`
        SELECT u.senha_hash, u.senha_temporaria, u.status::text AS status,
               e.status::text AS empresa_status
          FROM usuarios u
          LEFT JOIN empresas e ON e.id = u.company_id
         WHERE u.id = ${convite.usuarioId}::uuid
           FOR UPDATE OF u`;
      if (
        !usuario ||
        !this.contaAceitaOLink(
          {
            status: usuario.status,
            senhaTemporaria: usuario.senha_temporaria,
            senhaHash: usuario.senha_hash,
            empresaStatus: usuario.empresa_status,
          },
          convite.impressaoCredencial,
        )
      ) {
        throw linkInvalido();
      }

      const reivindicados = await tx.$executeRaw`
        UPDATE convites_de_acesso SET usado_em = now()
         WHERE id = ${convite.id}::uuid
           AND usado_em IS NULL AND revogado_em IS NULL
           AND expira_em > now()`;
      if (reivindicados !== 1) {
        throw linkInvalido();
      }

      await tx.usuario.update({
        where: { id: convite.usuarioId },
        data: {
          senhaHash,
          senhaTemporaria: false,
          senhaTemporariaExpiraEm: null,
        },
      });
      await tx.refreshToken.updateMany({
        where: { usuarioId: convite.usuarioId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }

  /**
   * D7 passo 3 — a conta ainda aceita este link? As quatro condições, e a
   * impressão por último. Na ativação, o estado vem da linha travada.
   */
  private contaAceitaOLink(
    conta: {
      status: string;
      senhaTemporaria: boolean;
      senhaHash: string;
      empresaStatus: string | null;
    },
    impressao: string,
  ): boolean {
    return (
      conta.status === 'ativo' &&
      conta.senhaTemporaria &&
      conta.empresaStatus === 'ativa' &&
      impressaoDaCredencial(conta.senhaHash) === impressao
    );
  }
}
