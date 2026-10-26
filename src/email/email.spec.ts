import { Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { createHash } from 'crypto';
import {
  carregarEmailConfig,
  CONFIGURACAO_DE_EMAIL,
  CONFIGURACAO_DOS_MODELOS,
  ConfiguracaoDeEmailInvalida,
  PADROES_FORA_DE_PRODUCAO,
  type ConfiguracaoDosModelos,
} from './email.config';
import { EmailModule } from './email.module';
import {
  escaparHtml,
  LIMITE_DO_NOME_NO_REMETENTE,
  nomeDoClubeNoRemetente,
} from './escapar-html';
import { MemoriaProvedorDeEmail } from './memoria-provedor-de-email';
import {
  BANNER_DO_EMAIL,
  CONVITE_DE_ACESSO,
  montarLinkDeAtivacao,
  renderizarConviteDeAcesso,
  VALIDADE_DO_CONVITE_EM_DIAS,
  type DadosDoConviteDeAcesso,
} from './modelos/convite-de-acesso';
import {
  montarLinkDeRedefinicao,
  REDEFINICAO_DE_SENHA,
  renderizarRedefinicaoDeSenha,
  VALIDADE_DA_REDEFINICAO_EM_MINUTOS,
  type DadosDaRedefinicaoDeSenha,
} from './modelos/redefinicao-de-senha';
// SPEC-090/AC-019 — o registro tem arquivo próprio desde o segundo modelo.
import { MODELOS_DE_EMAIL } from './modelos/registro';
import {
  MOTIVOS_DA_FALHA,
  PROVEDOR_DE_EMAIL,
  type MensagemDeEmail,
  type MotivoDaFalha,
} from './provedor-de-email';
import {
  chaveDoBloco,
  motivoDoErroDoResend,
  ResendProvedorDeEmail,
  type ClienteDoResend,
} from './resend-provedor-de-email';

// SPEC-083/TASK-003 — o MOD-015 (D8): porta, adaptadores, configuração e
// modelo. A parte de cada AC que depende de importar, enviar e ativar de
// verdade (AC-026, AC-027 e AC-031 por HTTP) é da TASK-004 e da TASK-005; aqui
// fica o que o módulo garante sozinho.

const CONFIG: ConfiguracaoDosModelos = {
  remetente: 'nao-responda@playck.com.br',
  responderPara: 'suporte@playck.com.br',
  urlCliente: 'https://app.playck.com.br',
  urlAdmin: 'https://admin.playck.com.br',
};

const TOKEN = CONVITE_DE_ACESSO.exemplo.token;

/**
 * SPEC-090/AC-019 (DOR-090-R1-04) — **os oráculos que eram globais, por
 * modelo.** Até o segundo modelo, "todo modelo tem campo de pessoa" e "todo
 * remetente é `<clube> via PlayCK`" eram verdade para o registro inteiro; a
 * redefinição não tem nenhum dos dois (D8). Em vez de afrouxar o oráculo, cada
 * modelo declara o seu — e o do convite fica **igual ou mais estrito**: os
 * campos passam de "pelo menos um" para "exatamente estes dois" (S20).
 *
 * **Um modelo do registro sem entrada aqui reprova** (S21): o terceiro modelo
 * não herda oráculo de ninguém por omissão.
 */
const ORACULOS_POR_MODELO: Readonly<
  Record<
    string,
    {
      readonly camposDePessoa: readonly string[];
      /** O remetente com `remetente: 'outro@exemplo.com'` na configuração. */
      readonly remetente: (from: string) => void;
    }
  >
> = {
  convite_de_acesso: {
    camposDePessoa: ['nomeDoClube', 'nomeDaPessoa'],
    remetente: (from) =>
      expect(from).toMatch(/ via PlayCK" <outro@exemplo\.com>$/),
  },
  redefinicao_de_senha: {
    camposDePessoa: [],
    remetente: (from) => expect(from).toBe('"PlayCK" <outro@exemplo.com>'),
  },
};

function oraculoDe(nome: string) {
  const oraculo = ORACULOS_POR_MODELO[nome];
  if (!oraculo) {
    throw new Error(`o modelo ${nome} não tem oráculo no email.spec.ts`);
  }
  return oraculo;
}

/** Os dois valores hostis do AC-028, exatamente como a spec os escreve. */
const INJECAO_DE_HTML = '"><a href="https://x">clique</a>';
const INJECAO_DE_CABECALHO = '\r\nBcc: x@x';

function convite(
  trocas: Partial<DadosDoConviteDeAcesso> = {},
): DadosDoConviteDeAcesso {
  return { ...CONVITE_DE_ACESSO.exemplo, ...trocas };
}

function redefinicao(
  trocas: Partial<DadosDaRedefinicaoDeSenha> = {},
): DadosDaRedefinicaoDeSenha {
  return { ...REDEFINICAO_DE_SENHA.exemplo, ...trocas };
}

function mensagens(quantas: number): MensagemDeEmail[] {
  return Array.from({ length: quantas }, (_, i) =>
    renderizarConviteDeAcesso(
      CONFIG,
      convite({
        conviteId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        token: `token-${i}`,
        para: `pessoa${i}@exemplo.com.br`,
      }),
    ),
  );
}

function tags(html: string): string[] {
  return html.match(/<[^>]*>/g) ?? [];
}

/**
 * Os atributos da tag como o navegador os lê: valor entre aspas duplas,
 * simples ou sem aspas, e **o primeiro vence** quando o nome se repete — um
 * leitor só de aspas duplas não veria um `style='...'` (achado da 2ª revisão
 * da TASK-003, quando um verificador de posição do banner ainda morava aqui).
 */
function atributos(tag: string): Map<string, string> {
  const lidos = new Map<string, string>();
  const corpo = tag.replace(/^<\/?[^\s/>]+/, '').replace(/\/?>$/, '');
  for (const [, nome, duplas, simples, nuas] of corpo.matchAll(
    /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
  )) {
    const chave = nome.toLowerCase();
    if (!lidos.has(chave)) lidos.set(chave, duplas ?? simples ?? nuas ?? '');
  }
  return lidos;
}

function atributo(tag: string, nome: string): string | null {
  return atributos(tag).get(nome) ?? null;
}

// ---------------------------------------------------------------------------
// O dublê do cliente da Resend. Tipos locais: este arquivo não pode importar o
// pacote (o gate do AC-029 varre os `.spec.ts` também).
// ---------------------------------------------------------------------------

type PedidoAoResend = {
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  html: string;
  text: string;
};
type OpcoesAoResend = {
  idempotencyKey?: string;
  signal?: AbortSignal;
  batchValidation?: string;
};
type ErroFalso = { name?: string; statusCode?: number | null };
type RespostaFalsa<T> = { data: T | null; error: ErroFalso | null };

function dubleDoResend() {
  const emails = jest.fn<
    Promise<RespostaFalsa<{ id: string }>>,
    [PedidoAoResend, OpcoesAoResend]
  >();
  const lote = jest.fn<
    Promise<RespostaFalsa<{ data: { id: string }[] }>>,
    [PedidoAoResend[], OpcoesAoResend]
  >();
  const cliente = {
    emails: { send: emails },
    batch: { send: lote },
  } as unknown as ClienteDoResend;
  return { cliente, emails, lote };
}

function loteAceito(prefixo: string) {
  return (pedidos: PedidoAoResend[]) =>
    Promise.resolve({
      data: { data: pedidos.map((_, i) => ({ id: `${prefixo}-${i}` })) },
      error: null,
    });
}

function falhaDoResend(erro: ErroFalso) {
  return () => Promise.resolve({ data: null, error: erro });
}

// O adaptador loga falha em `warn`, e a configuração loga o provedor no boot.
// Silenciados em todos os testes, e lidos no do AC-031.
const METODOS_DO_LOGGER = [
  'log',
  'warn',
  'error',
  'debug',
  'verbose',
  'fatal',
] as const;
let espioesDoLogger: Record<
  (typeof METODOS_DO_LOGGER)[number],
  jest.SpyInstance
>;
beforeEach(() => {
  espioesDoLogger = Object.fromEntries(
    METODOS_DO_LOGGER.map((metodo) => [
      metodo,
      jest.spyOn(Logger.prototype, metodo).mockImplementation(() => undefined),
    ]),
  ) as typeof espioesDoLogger;
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('AC-026 — a porta não lança: falha é resultado', () => {
  it.each(MOTIVOS_DA_FALHA)(
    'memória falhando com %s: ok:false com o motivo, avulso e lote',
    async (motivo) => {
      const memoria = new MemoriaProvedorDeEmail();
      memoria.falharCom(motivo);

      await expect(memoria.enviar(mensagens(1)[0])).resolves.toEqual({
        ok: false,
        motivo,
      });
      const lote = await memoria.enviarLote(mensagens(3));
      expect(lote).toEqual([
        { ok: false, motivo },
        { ok: false, motivo },
        { ok: false, motivo },
      ]);
      // Falhou, então nada conta como enviado — mas as chamadas existiram.
      expect(memoria.enviados).toHaveLength(0);
      expect(memoria.blocos).toHaveLength(2);
    },
  );

  it('memória volta a aceitar com falharCom(null)', async () => {
    const memoria = new MemoriaProvedorDeEmail();
    memoria.falharCom('cota');
    memoria.falharCom(null);
    await expect(memoria.enviar(mensagens(1)[0])).resolves.toEqual({
      ok: true,
      id: 'memoria-1',
    });
  });

  it.each<[string, ErroFalso, MotivoDaFalha]>([
    ['cota diária', { name: 'daily_quota_exceeded', statusCode: 429 }, 'cota'],
    [
      'chave inválida',
      { name: 'invalid_api_key', statusCode: 403 },
      'configuracao',
    ],
    [
      'domínio não verificado',
      { name: 'validation_error', statusCode: 403 },
      'configuracao',
    ],
    ['validação', { name: 'validation_error', statusCode: 422 }, 'recusado'],
    ['rede', { name: 'application_error', statusCode: null }, 'indisponivel'],
  ])(
    'Resend respondendo %s: resolve com o motivo, sem lançar',
    async (_rotulo, erro, motivo) => {
      const { cliente, emails } = dubleDoResend();
      emails.mockImplementation(falhaDoResend(erro));
      const provedor = new ResendProvedorDeEmail(cliente);

      await expect(provedor.enviar(mensagens(1)[0])).resolves.toEqual({
        ok: false,
        motivo,
      });
    },
  );

  it('Resend cujo cliente rejeita ou lança: indisponivel, sem lançar', async () => {
    const { cliente, emails, lote } = dubleDoResend();
    emails.mockRejectedValue(new TypeError('fetch failed'));
    lote.mockImplementation(() => {
      throw new Error('lançou antes de devolver promessa');
    });
    const provedor = new ResendProvedorDeEmail(cliente);

    await expect(provedor.enviar(mensagens(1)[0])).resolves.toEqual({
      ok: false,
      motivo: 'indisponivel',
    });
    await expect(provedor.enviarLote(mensagens(2))).resolves.toEqual([
      { ok: false, motivo: 'indisponivel' },
      { ok: false, motivo: 'indisponivel' },
    ]);
  });
});

describe('a tradução dos erros da Resend para os motivos da D8', () => {
  it.each<[ErroFalso, MotivoDaFalha]>([
    [{ name: 'daily_quota_exceeded', statusCode: 429 }, 'cota'],
    [{ name: 'monthly_quota_exceeded', statusCode: 429 }, 'cota'],
    [{ name: 'missing_api_key', statusCode: 401 }, 'configuracao'],
    [{ name: 'restricted_api_key', statusCode: 401 }, 'configuracao'],
    [{ name: 'invalid_api_key', statusCode: 403 }, 'configuracao'],
    [{ name: 'suspended_api_key', statusCode: 403 }, 'configuracao'],
    // "The domain is not verified": mesmo nome da validação comum, outro status.
    [{ name: 'validation_error', statusCode: 403 }, 'configuracao'],
    [{ name: 'invalid_from_address', statusCode: 422 }, 'configuracao'],
    [{ name: 'not_found', statusCode: 404 }, 'configuracao'],
    [{ name: 'validation_error', statusCode: 400 }, 'recusado'],
    [{ name: 'validation_error', statusCode: 422 }, 'recusado'],
    [{ name: 'missing_required_field', statusCode: 422 }, 'recusado'],
    [{ name: 'invalid_idempotent_request', statusCode: 409 }, 'recusado'],
    [{ name: 'rate_limit_exceeded', statusCode: 429 }, 'indisponivel'],
    [
      { name: 'concurrent_idempotent_requests', statusCode: 409 },
      'indisponivel',
    ],
    [{ name: 'application_error', statusCode: 500 }, 'indisponivel'],
    [{ name: 'internal_server_error', statusCode: 500 }, 'indisponivel'],
    [{ name: 'service_unavailable', statusCode: 503 }, 'indisponivel'],
    [{ name: 'application_error', statusCode: null }, 'indisponivel'],
    // Nome que nenhuma tabela conhece: o status decide.
    [{ name: 'erro_novo', statusCode: 502 }, 'indisponivel'],
    [{ name: 'erro_novo', statusCode: 401 }, 'configuracao'],
    [{ name: 'erro_novo', statusCode: 418 }, 'recusado'],
    [{}, 'indisponivel'],
  ])('%j vira %s', (erro, motivo) => {
    expect(motivoDoErroDoResend(erro)).toBe(motivo);
  });
});

describe('AC-027 (parte do módulo) — o link vem só da configuração', () => {
  it('é URL_CLIENTE + /ativar/ + token', () => {
    expect(montarLinkDeAtivacao(CONFIG, TOKEN)).toBe(
      `https://app.playck.com.br/ativar/${TOKEN}`,
    );
  });

  it('com URL_CLIENTE diferente, o link muda junto, no HTML e no texto', () => {
    const outra = { ...CONFIG, urlCliente: 'https://outro.exemplo.com' };
    const daqui = renderizarConviteDeAcesso(CONFIG, convite());
    const dali = renderizarConviteDeAcesso(outra, convite());

    expect(montarLinkDeAtivacao(outra, TOKEN)).toBe(
      `https://outro.exemplo.com/ativar/${TOKEN}`,
    );
    expect(dali.html).toContain(`https://outro.exemplo.com/ativar/${TOKEN}`);
    expect(dali.text).toContain(`https://outro.exemplo.com/ativar/${TOKEN}`);
    expect(dali.html).not.toContain('app.playck.com.br');
    expect(daqui.html).toContain(`https://app.playck.com.br/ativar/${TOKEN}`);
  });

  it('a assinatura não aceita requisição, host nem origem (INV-083e)', () => {
    const requisicaoForjada = {
      headers: {
        host: 'atacante.exemplo',
        origin: 'https://atacante.exemplo',
        'x-forwarded-host': 'atacante.exemplo',
      },
    };
    // Dois parâmetros, e nenhum é requisição. Se um dia a função passar a
    // receber o `Request`, o `@ts-expect-error` abaixo fica sem erro e o
    // typecheck reprova este arquivo.
    expect(montarLinkDeAtivacao).toHaveLength(2);
    // @ts-expect-error -- a função não recebe Request; é o que se prova aqui
    const link = montarLinkDeAtivacao(CONFIG, TOKEN, requisicaoForjada);
    expect(link).toBe(`https://app.playck.com.br/ativar/${TOKEN}`);
    expect(link).not.toContain('atacante');
  });

  it('o modelo cita a validade de 7 dias', () => {
    expect(VALIDADE_DO_CONVITE_EM_DIAS).toBe(7);
    const { html, text } = renderizarConviteDeAcesso(CONFIG, convite());
    expect(html).toContain('7 dias');
    expect(text).toContain('7 dias');
  });
});

describe('SPEC-090/AC-008 (parte do módulo) — o link da redefinição vem da configuração e do papel', () => {
  const TOKEN_090 = REDEFINICAO_DE_SENHA.exemplo.token;

  it('cliente: URL_CLIENTE + /redefinir-senha/ + token; admin: URL_ADMIN + o mesmo caminho', () => {
    expect(montarLinkDeRedefinicao(CONFIG, 'cliente', TOKEN_090)).toBe(
      `https://app.playck.com.br/redefinir-senha/${TOKEN_090}`,
    );
    expect(montarLinkDeRedefinicao(CONFIG, 'admin', TOKEN_090)).toBe(
      `https://admin.playck.com.br/redefinir-senha/${TOKEN_090}`,
    );
  });

  it('com outra URL_ADMIN, o link do gestor muda junto, no HTML e no texto', () => {
    const outra = { ...CONFIG, urlAdmin: 'https://outro-admin.exemplo.com' };
    const { html, text } = renderizarRedefinicaoDeSenha(
      outra,
      redefinicao({ destino: 'admin' }),
    );
    const link = `https://outro-admin.exemplo.com/redefinir-senha/${TOKEN_090}`;
    expect(html).toContain(link);
    expect(text).toContain(link);
    expect(html).not.toContain('admin.playck.com.br');
  });

  it('a assinatura não aceita requisição, host nem origem (INV-090d)', () => {
    const requisicaoForjada = {
      headers: {
        host: 'atacante.exemplo',
        origin: 'https://atacante.exemplo',
        referer: 'https://atacante.exemplo/esqueci-senha',
      },
    };
    // Três parâmetros, e nenhum é requisição. Se a função passar a receber o
    // `Request`, o `@ts-expect-error` fica sem erro e o typecheck reprova.
    expect(montarLinkDeRedefinicao).toHaveLength(3);
    const link = montarLinkDeRedefinicao(
      CONFIG,
      'cliente',
      TOKEN_090,
      // @ts-expect-error -- a função não recebe Request; é o que se prova aqui
      requisicaoForjada,
    );
    expect(link).toBe(`https://app.playck.com.br/redefinir-senha/${TOKEN_090}`);
    expect(link).not.toContain('atacante');
  });

  it('a validade é de 60 minutos, e o e-mail diz "1 hora"', () => {
    expect(VALIDADE_DA_REDEFINICAO_EM_MINUTOS).toBe(60);
    const { html, text } = renderizarRedefinicaoDeSenha(CONFIG, redefinicao());
    expect(html).toContain('O link vale por 1 hora');
    expect(text).toContain('O link vale por 1 hora');
  });
});

describe('SPEC-090/AC-020 — o e-mail da redefinição não leva nome de pessoa nem de clube', () => {
  /** Os dois nomes de clube hostis do AC-020, exatamente como a spec os escreve. */
  const CLUBE_HTML = '"><a href="https://x">';
  const CLUBE_CABECALHO = '\r\nBcc: x@x';

  it('dados com nomes hostis enfiados à força: nenhum dos dois textos aparece no HTML, no texto nem nos cabeçalhos', () => {
    // O tipo do modelo não tem campo de nome — é a prova de tipo. Esta é a de
    // execução: um modelo que lesse `nomeDoClube` ou `nomeDaPessoa` de onde
    // viessem, ou que iterasse os dados, deixaria o texto passar.
    const forcados = {
      ...redefinicao({ quantidadeDeContas: 2 }),
      nomeDoClube: CLUBE_HTML,
      nomeDaPessoa: CLUBE_CABECALHO,
      clubes: `${CLUBE_HTML}${CLUBE_CABECALHO}`,
    } as DadosDaRedefinicaoDeSenha;
    const mensagem = renderizarRedefinicaoDeSenha(CONFIG, forcados);

    for (const parte of [
      mensagem.html,
      mensagem.text,
      mensagem.from,
      mensagem.to,
      mensagem.replyTo,
      mensagem.subject,
    ]) {
      expect(parte).not.toContain(CLUBE_HTML);
      expect(parte).not.toContain('href="https://x"');
      expect(parte).not.toContain('Bcc:');
    }
    expect(mensagem.from).not.toMatch(/[\r\n]/);
    expect(mensagem.subject).not.toMatch(/[\r\n]/);
    // E o e-mail continua sendo o de duas contas: os dados foram lidos.
    expect(mensagem.text).toContain('Seu e-mail tem conta em 2 clubes.');
  });

  it('a declaração do modelo: nenhum campo de pessoa, e nenhum campo de nome nos dados', () => {
    expect(REDEFINICAO_DE_SENHA.camposDePessoa).toEqual([]);
    expect(Object.keys(REDEFINICAO_DE_SENHA.exemplo).sort()).toEqual([
      'destino',
      'para',
      'pedidoId',
      'quantidadeDeContas',
      'token',
    ]);
  });
});

describe('AC-028 — o modelo, com nome hostil de clube e de pessoa', () => {
  it('cada campo de pessoa declarado existe nos dados do modelo', () => {
    for (const modelo of MODELOS_DE_EMAIL) {
      for (const campo of modelo.camposDePessoa) {
        expect(Object.keys(modelo.exemplo)).toContain(campo);
      }
    }
  });

  it('SPEC-090/AC-019 — todo modelo do registro tem entrada no mapa de oráculos (S21)', () => {
    expect(MODELOS_DE_EMAIL.map((modelo) => modelo.nome)).toEqual([
      'convite_de_acesso',
      'redefinicao_de_senha',
    ]);
    for (const modelo of MODELOS_DE_EMAIL) {
      expect(Object.keys(ORACULOS_POR_MODELO)).toContain(modelo.nome);
    }
  });

  it.each(MODELOS_DE_EMAIL.map((modelo) => [modelo.nome, modelo] as const))(
    'SPEC-090/AC-019 — %s: os campos de pessoa são EXATAMENTE os do oráculo (S20)',
    (nome, modelo) => {
      expect(modelo.camposDePessoa).toEqual(oraculoDe(nome).camposDePessoa);
    },
  );

  // Um caso por modelo × campo × valor hostil: tirar o `escaparHtml()` de um
  // campo derruba só os casos daquele campo (S5).
  const casos = MODELOS_DE_EMAIL.flatMap((modelo) =>
    modelo.camposDePessoa.flatMap((campo) =>
      (
        [
          ['injeção de HTML', INJECAO_DE_HTML],
          ['injeção de cabeçalho', INJECAO_DE_CABECALHO],
        ] as const
      ).map(([rotulo, valor]) => ({ nome: modelo.nome, campo, rotulo, valor })),
    ),
  );

  it('são 4 casos hoje: convite × 2 campos × 2 valores, e a redefinição sem campo nenhum', () => {
    expect(casos).toHaveLength(4);
    expect(new Set(casos.map((caso) => caso.nome))).toEqual(
      new Set(['convite_de_acesso']),
    );
  });

  it.each(casos)(
    '$nome, campo $campo, $rotulo: nenhuma tag nova no HTML, remetente e assunto sem CR/LF',
    ({ nome, campo, valor }) => {
      const modelo = MODELOS_DE_EMAIL.find((m) => m.nome === nome);
      if (!modelo) throw new Error(`modelo ${nome} sumiu do registro`);
      const benigno = modelo.renderizar(CONFIG, modelo.exemplo);
      const hostil = modelo.renderizar(CONFIG, {
        ...modelo.exemplo,
        [campo]: valor,
      });

      // O valor hostil não pode acrescentar, tirar nem mudar uma tag sequer.
      expect(tags(hostil.html)).toEqual(tags(benigno.html));
      expect(hostil.html).not.toContain('<a href="https://x"');
      expect(hostil.html).not.toContain('clique</a>');
      if (valor === INJECAO_DE_HTML) {
        // E o texto chega, escapado: o nome não sumiu.
        expect(hostil.html).toContain(escaparHtml(INJECAO_DE_HTML));
      }

      expect(hostil.from).not.toMatch(/[\r\n]/);
      expect(hostil.subject).not.toMatch(/[\r\n]/);
      expect(hostil.from).toMatch(/^"[^"\\<>]+ via PlayCK" <[^<>\s]+>$/);
      expect(hostil.html.length).toBeGreaterThan(0);
      expect(hostil.text.length).toBeGreaterThan(0);
    },
  );

  it.each(MODELOS_DE_EMAIL.map((modelo) => [modelo.nome, modelo] as const))(
    '%s: a única imagem é o banner, com src, medidas e alt exatos',
    (_nome, modelo) => {
      const { html, text } = modelo.renderizar(CONFIG, modelo.exemplo);

      const imagens = html.match(/<img\b[^>]*>/gi) ?? [];
      expect(imagens).toHaveLength(1);
      const banner = imagens[0] ?? '';
      expect(atributo(banner, 'src')).toBe(
        'https://app.playck.com.br/email/playck-banner-v2.jpg',
      );
      expect(atributo(banner, 'src')).not.toContain('?');
      expect(atributo(banner, 'width')).toBe('600');
      expect(atributo(banner, 'height')).toBe('213');
      expect(atributo(banner, 'alt')).toBe(
        'PlayCK — Mais que esporte, é conexão.',
      );
      expect(BANNER_DO_EMAIL.alt).toBe('PlayCK — Mais que esporte, é conexão.');

      // Nenhum pixel nem outra imagem por outro caminho.
      expect(html).not.toMatch(/url\(|background=|<picture|<svg|<iframe/i);
      expect(text).not.toContain('<img');
    },
  );

  /**
   * D8/AC-028 — **o banner é o primeiro elemento visível do corpo, provado por
   * cópia literal revisada.**
   *
   * Antes daqui havia um verificador de HTML e CSS com 24 intrusos, e cada
   * rodada de revisão da TASK-003 achou mais uma forma de pôr algo visível
   * antes do banner que ele deixava passar, inclusive conteúdo que vem DEPOIS
   * dele no código e sobe na tela com `position` ou margem negativa. Uma lista
   * de formas proibidas não fecha. A igualdade fecha: com os dados do exemplo,
   * o modelo tem de gerar exatamente este HTML, conferido a olho em 2026-10-03.
   * Antes do banner, só o `<head>` sem estilo e as duas tabelas que o contêm,
   * sem conteúdo; depois dele, nada com `position`, margem negativa ou
   * transformação.
   *
   * **O alcance é o dos dados que o teste passa, não o do modelo inteiro.**
   * Ficam vermelhas: qualquer mudança no HTML que o exemplo produz, e nos dois
   * ramos que o modelo tem — nome da pessoa vazio (`Olá.`) e nome do clube
   * vazio (`PlayCK`), conferidos abaixo pela mesma cópia com uma troca só.
   * **Não fica vermelha** uma mudança que só aparece com outros valores — outra
   * `urlCliente`, outro token, um nome com certo comprimento: o link e o escape
   * desses campos têm provas próprias neste arquivo, mas a posição do banner
   * com eles, não. Quem acrescentar um ramo ao modelo acrescenta a sua cópia
   * aqui. O texto alternativo (`text`) entra junto, pela mesma razão, e quem
   * mudar o modelo revê o literal com os mesmos olhos antes de trocá-lo.
   */
  const HTML_REVISADO_DO_CONVITE = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;">
<tr><td style="padding:0;"><img src="https://app.playck.com.br/email/playck-banner-v2.jpg" width="600" height="213" alt="PlayCK — Mais que esporte, é conexão." style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>
<tr><td style="padding:32px 28px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;color:#18181b;">
<p style="margin:0 0 16px;">Olá, Maria Souza.</p>
<p style="margin:0 0 24px;"><strong>Clube Exemplo</strong> convidou você para o PlayCK. Crie a sua senha para entrar:</p>
<p style="margin:0 0 24px;"><a href="https://app.playck.com.br/ativar/dG9rZW4tZGUtZXhlbXBsby1kZS0zMi1ieXRlcy1hYmM" style="display:inline-block;padding:12px 24px;background-color:#18181b;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;">Criar minha senha</a></p>
<p style="margin:0 0 16px;font-size:14px;line-height:20px;color:#52525b;">Se o botão não abrir, copie este endereço no navegador:<br><a href="https://app.playck.com.br/ativar/dG9rZW4tZGUtZXhlbXBsby1kZS0zMi1ieXRlcy1hYmM" style="color:#18181b;word-break:break-all;">https://app.playck.com.br/ativar/dG9rZW4tZGUtZXhlbXBsby1kZS0zMi1ieXRlcy1hYmM</a></p>
<p style="margin:0 0 16px;font-size:14px;line-height:20px;color:#52525b;">O link vale por 7 dias e só pode ser usado uma vez.</p>
<p style="margin:0;font-size:14px;line-height:20px;color:#52525b;">Se você não esperava este convite, ignore este e-mail.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;

  const TEXTO_REVISADO_DO_CONVITE = `Olá, Maria Souza.

Clube Exemplo convidou você para o PlayCK. Crie a sua senha para entrar:

https://app.playck.com.br/ativar/dG9rZW4tZGUtZXhlbXBsby1kZS0zMi1ieXRlcy1hYmM

O link vale por 7 dias e só pode ser usado uma vez.

Se você não esperava este convite, ignore este e-mail.
`;

  it('convite_de_acesso: o HTML e o texto são exatamente a cópia revisada, com o banner primeiro', () => {
    const { html, text } = renderizarConviteDeAcesso(CONFIG, convite());
    expect(html).toBe(HTML_REVISADO_DO_CONVITE);
    expect(text).toBe(TEXTO_REVISADO_DO_CONVITE);
  });

  /**
   * A cópia de um ramo é a cópia revisada com **exatamente uma** troca: se a
   * âncora sumir ou se repetir, o teste quebra aqui, e não passa comparando
   * contra uma cópia que ninguém revisou.
   */
  function trocarUmaVez(base: string, de: string, para: string): string {
    expect(base.split(de)).toHaveLength(2);
    return base.replace(de, para);
  }

  it('convite_de_acesso sem nome da pessoa: a mesma cópia, com "Olá."', () => {
    const { html, text } = renderizarConviteDeAcesso(
      CONFIG,
      convite({ nomeDaPessoa: '' }),
    );
    expect(html).toBe(
      trocarUmaVez(
        HTML_REVISADO_DO_CONVITE,
        '<p style="margin:0 0 16px;">Olá, Maria Souza.</p>',
        '<p style="margin:0 0 16px;">Olá.</p>',
      ),
    );
    expect(text).toBe(
      trocarUmaVez(TEXTO_REVISADO_DO_CONVITE, 'Olá, Maria Souza.\n', 'Olá.\n'),
    );
  });

  it('convite_de_acesso sem nome do clube: a mesma cópia, com "PlayCK"', () => {
    const { html, text } = renderizarConviteDeAcesso(
      CONFIG,
      convite({ nomeDoClube: '' }),
    );
    expect(html).toBe(
      trocarUmaVez(
        HTML_REVISADO_DO_CONVITE,
        '<strong>Clube Exemplo</strong>',
        '<strong>PlayCK</strong>',
      ),
    );
    expect(text).toBe(
      trocarUmaVez(
        TEXTO_REVISADO_DO_CONVITE,
        'Clube Exemplo convidou',
        'PlayCK convidou',
      ),
    );
  });

  /**
   * SPEC-090/AC-019 — **a cópia revisada da redefinição**, no mesmo molde e
   * pela mesma razão da do convite: com os dados do exemplo (uma conta, link
   * do Cliente), o modelo tem de gerar exatamente este HTML, conferido a olho
   * em 2026-10-26. Antes do banner, só o `<head>` sem estilo e as duas tabelas
   * que o contêm. **O texto é o da D8 e nada mais** (REV-090-B04): sem o "Se o
   * botão não abrir…" do convite, e a saudação num parágrafo só.
   *
   * **Os ramos:** N contas (a linha "Seu e-mail tem conta em N clubes") e o
   * link do Admin, cada um pela mesma cópia com uma troca só. O alcance é o
   * dos dados que o teste passa, como o do convite.
   */
  const HTML_REVISADO_DA_REDEFINICAO = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;">
<tr><td style="padding:0;"><img src="https://app.playck.com.br/email/playck-banner-v2.jpg" width="600" height="213" alt="PlayCK — Mais que esporte, é conexão." style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>
<tr><td style="padding:32px 28px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;color:#18181b;">
<p style="margin:0 0 24px;">Olá. Recebemos um pedido para redefinir a senha da sua conta no PlayCK.</p>
<p style="margin:0 0 24px;"><a href="https://app.playck.com.br/redefinir-senha/cmVkZWZpbmljYW8tZGUtZXhlbXBsby0zMi1ieXRlczA" style="display:inline-block;padding:12px 24px;background-color:#18181b;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;">Redefinir minha senha</a></p>
<p style="margin:0 0 16px;font-size:14px;line-height:20px;color:#52525b;"><a href="https://app.playck.com.br/redefinir-senha/cmVkZWZpbmljYW8tZGUtZXhlbXBsby0zMi1ieXRlczA" style="color:#18181b;word-break:break-all;">https://app.playck.com.br/redefinir-senha/cmVkZWZpbmljYW8tZGUtZXhlbXBsby0zMi1ieXRlczA</a></p>
<p style="margin:0 0 16px;font-size:14px;line-height:20px;color:#52525b;">O link vale por 1 hora e só pode ser usado uma vez.</p>
<p style="margin:0;font-size:14px;line-height:20px;color:#52525b;">Se você não pediu, ignore este e-mail. Sua senha continua a mesma.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;

  const TEXTO_REVISADO_DA_REDEFINICAO = `Olá. Recebemos um pedido para redefinir a senha da sua conta no PlayCK.

https://app.playck.com.br/redefinir-senha/cmVkZWZpbmljYW8tZGUtZXhlbXBsby0zMi1ieXRlczA

O link vale por 1 hora e só pode ser usado uma vez.

Se você não pediu, ignore este e-mail. Sua senha continua a mesma.
`;

  it('SPEC-090/AC-019 — redefinicao_de_senha, uma conta: o HTML e o texto são exatamente a cópia revisada', () => {
    const { html, text } = renderizarRedefinicaoDeSenha(CONFIG, redefinicao());
    expect(html).toBe(HTML_REVISADO_DA_REDEFINICAO);
    expect(text).toBe(TEXTO_REVISADO_DA_REDEFINICAO);
  });

  it('SPEC-090/AC-019 — redefinicao_de_senha, três contas: a mesma cópia, com a linha dos clubes depois da validade', () => {
    const { html, text } = renderizarRedefinicaoDeSenha(
      CONFIG,
      redefinicao({ quantidadeDeContas: 3 }),
    );
    const validade =
      '<p style="margin:0 0 16px;font-size:14px;line-height:20px;color:#52525b;">O link vale por 1 hora e só pode ser usado uma vez.</p>\n';
    expect(html).toBe(
      trocarUmaVez(
        HTML_REVISADO_DA_REDEFINICAO,
        validade,
        `${validade}<p style="margin:0 0 16px;font-size:14px;line-height:20px;color:#52525b;">Seu e-mail tem conta em 3 clubes. Ao abrir o link, escolha qual conta vai ter a senha redefinida.</p>\n`,
      ),
    );
    expect(text).toBe(
      trocarUmaVez(
        TEXTO_REVISADO_DA_REDEFINICAO,
        'uma vez.\n\n',
        'uma vez.\n\nSeu e-mail tem conta em 3 clubes. Ao abrir o link, escolha qual conta vai ter a senha redefinida.\n\n',
      ),
    );
  });

  it('SPEC-090/AC-019 — redefinicao_de_senha, link do Admin: a mesma cópia, com a origem do Admin nos três lugares do link', () => {
    const { html, text } = renderizarRedefinicaoDeSenha(
      CONFIG,
      redefinicao({ destino: 'admin' }),
    );
    const doCliente = 'https://app.playck.com.br/redefinir-senha/';
    const doAdmin = 'https://admin.playck.com.br/redefinir-senha/';
    // Três no HTML (o botão, o `href` do endereço e o endereço por extenso) e
    // um no texto; o banner continua vindo do Cliente.
    expect(HTML_REVISADO_DA_REDEFINICAO.split(doCliente)).toHaveLength(4);
    expect(html).toBe(
      HTML_REVISADO_DA_REDEFINICAO.split(doCliente).join(doAdmin),
    );
    expect(text).toBe(
      trocarUmaVez(TEXTO_REVISADO_DA_REDEFINICAO, doCliente, doAdmin),
    );
    expect(html).toContain(
      'src="https://app.playck.com.br/email/playck-banner-v2.jpg"',
    );
  });

  it('todo modelo do registro tem a sua cópia revisada', () => {
    // Um modelo novo no registro sem cópia revisada reprova aqui: a prova do
    // banner não pode ficar para trás quando o segundo modelo chegar.
    const revisados: Readonly<Record<string, string>> = {
      convite_de_acesso: HTML_REVISADO_DO_CONVITE,
      redefinicao_de_senha: HTML_REVISADO_DA_REDEFINICAO,
    };
    for (const modelo of MODELOS_DE_EMAIL) {
      expect(Object.keys(revisados)).toContain(modelo.nome);
      expect(modelo.renderizar(CONFIG, modelo.exemplo).html).toBe(
        revisados[modelo.nome],
      );
    }
  });
});

describe('AC-041 — remetente e reply_to', () => {
  it('saem como a D8 manda, conferidos no provedor memória', async () => {
    const memoria = new MemoriaProvedorDeEmail();
    await memoria.enviar(renderizarConviteDeAcesso(CONFIG, convite()));

    expect(memoria.enviados).toHaveLength(1);
    expect(memoria.enviados[0].from).toBe(
      '"Clube Exemplo via PlayCK" <nao-responda@playck.com.br>',
    );
    expect(memoria.enviados[0].replyTo).toBe('suporte@playck.com.br');
    expect(memoria.enviados[0].to).toBe(CONVITE_DE_ACESSO.exemplo.para);
    expect(memoria.enviados[0].subject).toBe(
      'Clube Exemplo convidou você para o PlayCK',
    );
  });

  it.each(MODELOS_DE_EMAIL.map((modelo) => [modelo.nome, modelo] as const))(
    '%s: todo modelo usa EMAIL_REMETENTE e EMAIL_RESPONDER_PARA da configuração (o remetente pelo oráculo do modelo, SPEC-090/AC-019)',
    (nome, modelo) => {
      const outra = {
        ...CONFIG,
        remetente: 'outro@exemplo.com',
        responderPara: 'ajuda@exemplo.com',
      };
      const mensagem = modelo.renderizar(outra, modelo.exemplo);
      oraculoDe(nome).remetente(mensagem.from);
      expect(mensagem.replyTo).toBe('ajuda@exemplo.com');
    },
  );

  it('SPEC-090/D8 — a redefinição: remetente "PlayCK", assunto fixo, chave pelo id do pedido', () => {
    const mensagem = renderizarRedefinicaoDeSenha(CONFIG, redefinicao());
    expect(mensagem.from).toBe('"PlayCK" <nao-responda@playck.com.br>');
    expect(mensagem.replyTo).toBe('suporte@playck.com.br');
    expect(mensagem.to).toBe(REDEFINICAO_DE_SENHA.exemplo.para);
    expect(mensagem.subject).toBe('Redefinir sua senha do PlayCK');
    expect(mensagem.chaveDeIdempotencia).toBe(
      `redefinicao-de-senha/${REDEFINICAO_DE_SENHA.exemplo.pedidoId}`,
    );
  });

  it('o adaptador da Resend repassa o reply_to e só os campos da mensagem', async () => {
    const { cliente, emails } = dubleDoResend();
    emails.mockResolvedValue({ data: { id: 're-1' }, error: null });
    const provedor = new ResendProvedorDeEmail(cliente);
    const mensagem = renderizarConviteDeAcesso(CONFIG, convite());

    await expect(provedor.enviar(mensagem)).resolves.toEqual({
      ok: true,
      id: 're-1',
    });
    const [pedido, opcoes] = emails.mock.calls[0];
    expect(pedido).toEqual({
      from: mensagem.from,
      to: mensagem.to,
      replyTo: 'suporte@playck.com.br',
      subject: mensagem.subject,
      html: mensagem.html,
      text: mensagem.text,
    });
    // D8 — o avulso usa `convite-de-acesso/<id>` como chave.
    expect(opcoes.idempotencyKey).toBe(
      `convite-de-acesso/${CONVITE_DE_ACESSO.exemplo.conviteId}`,
    );
    expect(opcoes.signal).toBeInstanceOf(AbortSignal);
  });

  describe('o nome do clube no remetente, higienizado', () => {
    it.each<[string, string, string]>([
      ['aspas, sinais e barra invertida', 'Clube "A" <b> \\ C', 'Clube A b C'],
      ['CR e LF', 'Clube\r\nBcc: x@x', 'Clube Bcc: x@x'],
      ['controle', 'Clube\u0000\u0007X', 'Clube X'],
      ['vazio', '', 'PlayCK'],
      ['só caracteres proibidos', '"<>\\', 'PlayCK'],
    ])('%s', (_rotulo, nome, esperado) => {
      expect(nomeDoClubeNoRemetente(nome)).toBe(esperado);
    });

    it('corta em 60 caracteres sem partir um emoji', () => {
      const longo = `${'a'.repeat(59)}🎾🎾🎾`;
      const nome = nomeDoClubeNoRemetente(longo);
      expect(Array.from(nome)).toHaveLength(LIMITE_DO_NOME_NO_REMETENTE);
      expect(nome).toBe(`${'a'.repeat(59)}🎾`);
    });

    it('no modelo, o remetente traz o nome higienizado', () => {
      const { from } = renderizarConviteDeAcesso(
        CONFIG,
        convite({ nomeDoClube: INJECAO_DE_HTML }),
      );
      expect(from).toBe(
        '"a href=https://xclique/a via PlayCK" <nao-responda@playck.com.br>',
      );
    });
  });
});

describe('AC-032 — o lote em blocos de 100, cada um com a sua chave', () => {
  it('150 mensagens: duas chamadas (100 e 50), chaves diferentes', async () => {
    const { cliente, emails, lote } = dubleDoResend();
    lote
      .mockImplementationOnce(loteAceito('primeiro'))
      .mockImplementationOnce(loteAceito('segundo'));
    const provedor = new ResendProvedorDeEmail(cliente);
    const todas = mensagens(150);

    const resultados = await provedor.enviarLote(todas);

    expect(emails).not.toHaveBeenCalled();
    expect(lote).toHaveBeenCalledTimes(2);
    const [[primeiro, opcoesDoPrimeiro], [segundo, opcoesDoSegundo]] =
      lote.mock.calls;
    expect(primeiro).toHaveLength(100);
    expect(segundo).toHaveLength(50);
    expect(primeiro[0].to).toBe(todas[0].to);
    expect(segundo[0].to).toBe(todas[100].to);

    // A chave é o sha256 das chaves das mensagens (os ids) do bloco,
    // recalculado aqui de forma independente.
    const sha256 = (bloco: MensagemDeEmail[]) =>
      createHash('sha256')
        .update(bloco.map((m) => m.chaveDeIdempotencia).join('\n'))
        .digest('hex');
    expect(opcoesDoPrimeiro.idempotencyKey).toBe(sha256(todas.slice(0, 100)));
    expect(opcoesDoSegundo.idempotencyKey).toBe(sha256(todas.slice(100)));
    expect(opcoesDoPrimeiro.idempotencyKey).not.toBe(
      opcoesDoSegundo.idempotencyKey,
    );
    expect(chaveDoBloco(todas.slice(0, 100))).toBe(
      opcoesDoPrimeiro.idempotencyKey,
    );
    // D8 — o bloco recusado inteiro depende do modo `strict`.
    expect(opcoesDoPrimeiro.batchValidation).toBe('strict');
    expect(opcoesDoSegundo.batchValidation).toBe('strict');

    // Um resultado por mensagem, na ordem, com o id que a Resend devolveu.
    expect(resultados).toHaveLength(150);
    expect(resultados[0]).toEqual({ ok: true, id: 'primeiro-0' });
    expect(resultados[99]).toEqual({ ok: true, id: 'primeiro-99' });
    expect(resultados[100]).toEqual({ ok: true, id: 'segundo-0' });
    expect(resultados[149]).toEqual({ ok: true, id: 'segundo-49' });
  });

  it('bloco recusado inteiro: todas as mensagens dele com o mesmo motivo, e só dele', async () => {
    const { cliente, lote } = dubleDoResend();
    lote
      .mockImplementationOnce(loteAceito('aceito'))
      .mockImplementationOnce(
        falhaDoResend({ name: 'daily_quota_exceeded', statusCode: 429 }),
      );
    const provedor = new ResendProvedorDeEmail(cliente);

    const resultados = await provedor.enviarLote(mensagens(150));

    expect(resultados.slice(0, 100).every((r) => r.ok)).toBe(true);
    expect(resultados.slice(100)).toEqual(
      Array.from({ length: 50 }, () => ({ ok: false, motivo: 'cota' })),
    );
  });

  it('resposta sem id para uma mensagem: aquela não é dada por aceita', async () => {
    const { cliente, lote } = dubleDoResend();
    lote.mockResolvedValue({
      data: { data: [{ id: 'a' }, { id: 'b' }] },
      error: null,
    });
    const provedor = new ResendProvedorDeEmail(cliente);

    await expect(provedor.enviarLote(mensagens(3))).resolves.toEqual([
      { ok: true, id: 'a' },
      { ok: true, id: 'b' },
      { ok: false, motivo: 'indisponivel' },
    ]);
  });

  it('lote vazio não chama a Resend', async () => {
    const { cliente, lote } = dubleDoResend();
    const provedor = new ResendProvedorDeEmail(cliente);
    await expect(provedor.enviarLote([])).resolves.toEqual([]);
    expect(lote).not.toHaveBeenCalled();
  });

  it('o provedor memória registra os blocos como a Resend os receberia', async () => {
    const memoria = new MemoriaProvedorDeEmail();
    await memoria.enviarLote(mensagens(150));
    expect(memoria.blocos.map((bloco) => bloco.length)).toEqual([100, 50]);
    expect(memoria.enviados).toHaveLength(150);
  });
});

/**
 * D8: "tempo máximo de **10 s** por chamada" — em LITERAIS, e não pela
 * constante do adaptador (IMP-083-01, validação R1). O oráculo que importa a
 * constante se move junto com ela: com o teto trocado para `30_000`, a prova
 * antiga seguia verde. Estes dois instantes são da norma; se o adaptador
 * mudar o teto, é aqui que alguém tem de discordar.
 */
const AINDA_NO_PRAZO_MS = 9_999;
const TETO_DA_NORMA_MS = 10_000;

/** Uma promessa e a pergunta "já resolveu?", sem esperar por ela. */
function acompanhar<T>(promessa: Promise<T>) {
  let resolveu = false;
  const acompanhada = promessa.then((valor) => {
    resolveu = true;
    return valor;
  });
  return { promessa: acompanhada, resolveu: () => resolveu };
}

describe('o tempo máximo de 10 s por chamada', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('avulso que não responde: em 9.999 ms ainda espera; em 10.000 ms desiste com tempo_esgotado, e o pedido é abortado', async () => {
    const { cliente, emails } = dubleDoResend();
    let sinal: AbortSignal | undefined;
    emails.mockImplementation((_pedido, opcoes) => {
      sinal = opcoes.signal;
      return new Promise(() => undefined);
    });
    const provedor = new ResendProvedorDeEmail(cliente);
    const envio = acompanhar(provedor.enviar(mensagens(1)[0]));

    await jest.advanceTimersByTimeAsync(AINDA_NO_PRAZO_MS);
    expect(envio.resolveu()).toBe(false);
    expect(sinal?.aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(TETO_DA_NORMA_MS - AINDA_NO_PRAZO_MS);
    // Resolvida AQUI, sem mais relógio: um teto mais tardio pararia nesta
    // linha, e não no tempo limite do jest.
    expect(envio.resolveu()).toBe(true);
    await expect(envio.promessa).resolves.toEqual({
      ok: false,
      motivo: 'tempo_esgotado',
    });
    expect(sinal?.aborted).toBe(true);
  });

  it('o SDK abortado devolve erro de rede; mesmo assim é tempo_esgotado', async () => {
    // É o que o SDK 6.32 faz de verdade: o `fetch` abortado cai no mesmo
    // `catch` da rede e volta como `application_error` sem status.
    const { cliente, emails } = dubleDoResend();
    emails.mockImplementation(
      (_pedido, opcoes) =>
        new Promise((resolver) => {
          opcoes.signal?.addEventListener('abort', () =>
            resolver({
              data: null,
              error: { name: 'application_error', statusCode: null },
            }),
          );
        }),
    );
    const provedor = new ResendProvedorDeEmail(cliente);
    const envio = acompanhar(provedor.enviar(mensagens(1)[0]));

    await jest.advanceTimersByTimeAsync(AINDA_NO_PRAZO_MS);
    expect(envio.resolveu()).toBe(false);

    await jest.advanceTimersByTimeAsync(TETO_DA_NORMA_MS - AINDA_NO_PRAZO_MS);
    expect(envio.resolveu()).toBe(true);
    await expect(envio.promessa).resolves.toEqual({
      ok: false,
      motivo: 'tempo_esgotado',
    });
  });

  it('bloco que não responde: em 9.999 ms o segundo bloco ainda não saiu; em 10.000 ms as mensagens do primeiro saem tempo_esgotado, e o próximo bloco sai', async () => {
    const { cliente, lote } = dubleDoResend();
    lote
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockImplementationOnce(loteAceito('segundo'));
    const provedor = new ResendProvedorDeEmail(cliente);
    const envio = acompanhar(provedor.enviarLote(mensagens(150)));

    await jest.advanceTimersByTimeAsync(AINDA_NO_PRAZO_MS);
    expect(envio.resolveu()).toBe(false);
    // Em série: o segundo bloco espera o primeiro desistir.
    expect(lote).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(TETO_DA_NORMA_MS - AINDA_NO_PRAZO_MS);
    expect(envio.resolveu()).toBe(true);
    const resultados = await envio.promessa;

    expect(lote).toHaveBeenCalledTimes(2);
    expect(resultados.slice(0, 100)).toEqual(
      Array.from({ length: 100 }, () => ({
        ok: false,
        motivo: 'tempo_esgotado',
      })),
    );
    expect(resultados[100]).toEqual({ ok: true, id: 'segundo-0' });
  });

  it('resposta dentro do prazo desarma o relógio', async () => {
    const { cliente, emails } = dubleDoResend();
    emails.mockResolvedValue({ data: { id: 're-1' }, error: null });
    const provedor = new ResendProvedorDeEmail(cliente);

    await expect(provedor.enviar(mensagens(1)[0])).resolves.toEqual({
      ok: true,
      id: 're-1',
    });
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('AC-031 (parte do módulo) — nada de token, link ou corpo em log', () => {
  it('nem no sucesso, nem na falha, nem na exceção, nem no tempo esgotado', async () => {
    const espioesDoConsole = (
      ['log', 'info', 'warn', 'error', 'debug'] as const
    ).map((metodo) =>
      jest.spyOn(console, metodo).mockImplementation(() => undefined),
    );
    const segredo = 'tOkEn-QuE-nUnCa-VaI-a-lOg';
    const mensagem = renderizarConviteDeAcesso(
      CONFIG,
      convite({ token: segredo }),
    );
    const link = montarLinkDeAtivacao(CONFIG, segredo);

    const { cliente, emails, lote } = dubleDoResend();
    emails
      .mockResolvedValueOnce({ data: { id: 're-1' }, error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { name: 'validation_error', statusCode: 422 },
      })
      // A exceção carrega o link na mensagem: só o nome dela pode ir a log.
      .mockRejectedValueOnce(new Error(`falhou ao enviar ${link}`));
    lote.mockResolvedValueOnce({
      data: null,
      error: { name: 'monthly_quota_exceeded', statusCode: 429 },
    });
    const provedor = new ResendProvedorDeEmail(cliente);

    await provedor.enviar(mensagem);
    await provedor.enviar(mensagem);
    await provedor.enviar(mensagem);
    await provedor.enviarLote([mensagem, mensagem]);

    jest.useFakeTimers();
    try {
      emails.mockImplementationOnce(() => new Promise(() => undefined));
      const esgotado = provedor.enviar(mensagem);
      await jest.advanceTimersByTimeAsync(TETO_DA_NORMA_MS);
      await expect(esgotado).resolves.toEqual({
        ok: false,
        motivo: 'tempo_esgotado',
      });
    } finally {
      jest.useRealTimers();
    }

    const registrado = [...Object.values(espioesDoLogger), ...espioesDoConsole]
      .flatMap((espiao) => espiao.mock.calls as unknown[][])
      .map((argumentos) => JSON.stringify(argumentos))
      .join('\n');

    // Não é vacuidade: as quatro falhas foram registradas.
    expect(espioesDoLogger.warn.mock.calls).toHaveLength(4);
    expect(registrado).toContain('email_falhou');

    expect(registrado).not.toContain(segredo);
    expect(registrado).not.toContain(link);
    expect(registrado).not.toContain(mensagem.to);
    expect(registrado).not.toContain('Criar minha senha');
  });
});

describe('AC-030 — a configuração, validada no boot', () => {
  /**
   * SPEC-090/AC-021 — **a `URL_ADMIN` válida entra aqui.** Sem ela, todo caso
   * de "em produção, recusa %s" ficaria verde por falta de `URL_ADMIN`, sem
   * provar a recusa que diz provar — e por isso cada caso confere também a
   * variável citada na mensagem (S24).
   */
  const PRODUCAO: Record<string, string> = {
    NODE_ENV: 'production',
    EMAIL_PROVEDOR: 'resend',
    RESEND_API_KEY: 're_chave_so_de_envio',
    EMAIL_REMETENTE: 'nao-responda@playck.com.br',
    EMAIL_RESPONDER_PARA: 'suporte@playck.com.br',
    URL_CLIENTE: 'https://app.playck.com.br',
    URL_ADMIN: 'https://admin.playck.com.br',
  };

  function configCom(valores: Record<string, string | undefined>) {
    return { get: (nome: string) => valores[nome] } as unknown as ConfigService;
  }

  function emProducao(trocas: Record<string, string | undefined>) {
    return configCom({ ...PRODUCAO, ...trocas });
  }

  it('produção completa carrega, com a URL do Cliente sem barra final', () => {
    expect(
      carregarEmailConfig(
        emProducao({ URL_CLIENTE: 'https://app.playck.com.br/' }),
      ),
    ).toEqual({
      provedor: 'resend',
      chaveDoResend: 're_chave_so_de_envio',
      remetente: 'nao-responda@playck.com.br',
      responderPara: 'suporte@playck.com.br',
      urlCliente: 'https://app.playck.com.br',
      urlAdmin: 'https://admin.playck.com.br',
    });
  });

  it('SPEC-090/AC-021 — produção sobe com URL_ADMIN https://admin.exemplo, sem barra final', () => {
    expect(
      carregarEmailConfig(emProducao({ URL_ADMIN: 'https://admin.exemplo/' }))
        .urlAdmin,
    ).toBe('https://admin.exemplo');
  });

  /**
   * O terceiro elemento é a variável que a mensagem tem de citar
   * (SPEC-090/AC-021): uma recusa por outra variável não conta como a deste
   * caso.
   */
  it.each<[string, Record<string, string | undefined>, string]>([
    ['EMAIL_PROVEDOR=memoria', { EMAIL_PROVEDOR: 'memoria' }, 'EMAIL_PROVEDOR'],
    ['EMAIL_PROVEDOR ausente', { EMAIL_PROVEDOR: undefined }, 'EMAIL_PROVEDOR'],
    [
      'EMAIL_PROVEDOR desconhecido',
      { EMAIL_PROVEDOR: 'smtp' },
      'EMAIL_PROVEDOR',
    ],
    ['sem RESEND_API_KEY', { RESEND_API_KEY: undefined }, 'RESEND_API_KEY'],
    ['RESEND_API_KEY em branco', { RESEND_API_KEY: '   ' }, 'RESEND_API_KEY'],
    [
      'RESEND_API_KEY com quebra de linha',
      { RESEND_API_KEY: 're_a\nb' },
      'RESEND_API_KEY',
    ],
    [
      'sem EMAIL_RESPONDER_PARA',
      { EMAIL_RESPONDER_PARA: undefined },
      'EMAIL_RESPONDER_PARA',
    ],
    [
      'EMAIL_RESPONDER_PARA sem @',
      { EMAIL_RESPONDER_PARA: 'suporte' },
      'EMAIL_RESPONDER_PARA',
    ],
    [
      'EMAIL_RESPONDER_PARA com nome de exibição',
      { EMAIL_RESPONDER_PARA: 'Suporte <suporte@playck.com.br>' },
      'EMAIL_RESPONDER_PARA',
    ],
    [
      'EMAIL_RESPONDER_PARA com cabeçalho injetado',
      { EMAIL_RESPONDER_PARA: 'suporte@playck.com.br\r\nBcc: x@x' },
      'EMAIL_RESPONDER_PARA',
    ],
    ['sem EMAIL_REMETENTE', { EMAIL_REMETENTE: undefined }, 'EMAIL_REMETENTE'],
    [
      'EMAIL_REMETENTE inválido',
      { EMAIL_REMETENTE: 'nao-responda' },
      'EMAIL_REMETENTE',
    ],
    ['sem URL_CLIENTE', { URL_CLIENTE: undefined }, 'URL_CLIENTE'],
    [
      'URL_CLIENTE sem https',
      { URL_CLIENTE: 'http://app.playck.com.br' },
      'URL_CLIENTE',
    ],
    [
      'URL_CLIENTE com caminho',
      { URL_CLIENTE: 'https://app.playck.com.br/cliente' },
      'URL_CLIENTE',
    ],
    [
      'URL_CLIENTE com query',
      { URL_CLIENTE: 'https://app.playck.com.br/?x=1' },
      'URL_CLIENTE',
    ],
    [
      'URL_CLIENTE relativa',
      { URL_CLIENTE: 'app.playck.com.br' },
      'URL_CLIENTE',
    ],
    // SPEC-090/AC-021 — a `URL_ADMIN`, pela mesma regra (S14).
    ['sem URL_ADMIN', { URL_ADMIN: undefined }, 'URL_ADMIN'],
    ['URL_ADMIN em branco', { URL_ADMIN: '  ' }, 'URL_ADMIN'],
    [
      'URL_ADMIN sem https',
      { URL_ADMIN: 'http://admin.playck.com.br' },
      'URL_ADMIN',
    ],
    [
      'URL_ADMIN com caminho',
      { URL_ADMIN: 'https://admin.playck.com.br/admin' },
      'URL_ADMIN',
    ],
    [
      'URL_ADMIN com credencial',
      { URL_ADMIN: 'https://usuario:senha@admin.playck.com.br' },
      'URL_ADMIN',
    ],
    [
      'URL_ADMIN com query',
      { URL_ADMIN: 'https://admin.playck.com.br/?x=1' },
      'URL_ADMIN',
    ],
    ['URL_ADMIN relativa', { URL_ADMIN: 'admin.playck.com.br' }, 'URL_ADMIN'],
  ])('em produção, recusa %s', (_rotulo, trocas, variavel) => {
    const carregar = () => carregarEmailConfig(emProducao(trocas));
    expect(carregar).toThrow(ConfiguracaoDeEmailInvalida);
    expect(carregar).toThrow(new RegExp(variavel));
  });

  it('não ecoa a chave na mensagem de erro (segredo em log de boot)', () => {
    let mensagem = '';
    try {
      carregarEmailConfig(emProducao({ RESEND_API_KEY: 're_segredo vazado' }));
    } catch (erro) {
      mensagem = (erro as Error).message;
    }
    expect(mensagem).toMatch(/RESEND_API_KEY/);
    expect(mensagem).not.toContain('re_segredo');
  });

  it('fora de produção, sem nenhuma variável: memória e os padrões', () => {
    expect(carregarEmailConfig(configCom({ NODE_ENV: 'test' }))).toEqual({
      provedor: 'memoria',
      chaveDoResend: null,
      remetente: PADROES_FORA_DE_PRODUCAO.EMAIL_REMETENTE,
      responderPara: PADROES_FORA_DE_PRODUCAO.EMAIL_RESPONDER_PARA,
      urlCliente: PADROES_FORA_DE_PRODUCAO.URL_CLIENTE,
      urlAdmin: 'http://localhost:3001',
    });
    expect(PADROES_FORA_DE_PRODUCAO.URL_ADMIN).toBe('http://localhost:3001');
  });

  it('fora de produção, o que vier ainda é validado', () => {
    expect(() =>
      carregarEmailConfig(configCom({ EMAIL_PROVEDOR: 'resend' })),
    ).toThrow(/RESEND_API_KEY/);
    expect(() =>
      carregarEmailConfig(configCom({ EMAIL_RESPONDER_PARA: 'x' })),
    ).toThrow(/EMAIL_RESPONDER_PARA/);
    expect(() =>
      carregarEmailConfig(configCom({ URL_CLIENTE: 'ftp://x.com' })),
    ).toThrow(/URL_CLIENTE/);
    expect(
      carregarEmailConfig(configCom({ URL_CLIENTE: 'http://localhost:3003/' }))
        .urlCliente,
    ).toBe('http://localhost:3003');
    // SPEC-090/AC-021 — a `URL_ADMIN` também, fora de produção.
    expect(() =>
      carregarEmailConfig(configCom({ URL_ADMIN: 'ftp://x.com' })),
    ).toThrow(/URL_ADMIN/);
    expect(() =>
      carregarEmailConfig(configCom({ URL_ADMIN: 'http://u:s@x.com' })),
    ).toThrow(/URL_ADMIN/);
    expect(
      carregarEmailConfig(configCom({ URL_ADMIN: 'http://localhost:3001/' }))
        .urlAdmin,
    ).toBe('http://localhost:3001');
  });

  describe('o EmailModule, montado de verdade', () => {
    function compilarCom(valores: Record<string, string | undefined>) {
      return Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
          EmailModule,
        ],
      })
        .overrideProvider(ConfigService)
        .useValue(configCom(valores))
        .compile();
    }

    it('não sobe em produção sem EMAIL_RESPONDER_PARA', async () => {
      await expect(
        compilarCom({ ...PRODUCAO, EMAIL_RESPONDER_PARA: undefined }),
      ).rejects.toThrow(ConfiguracaoDeEmailInvalida);
    });

    it('SPEC-090/AC-021 — não sobe em produção sem URL_ADMIN', async () => {
      await expect(
        compilarCom({ ...PRODUCAO, URL_ADMIN: undefined }),
      ).rejects.toThrow(/URL_ADMIN/);
    });

    it('SPEC-090/AC-021 — não sobe em produção com URL_ADMIN http://', async () => {
      await expect(
        compilarCom({ ...PRODUCAO, URL_ADMIN: 'http://admin.exemplo' }),
      ).rejects.toThrow(/URL_ADMIN/);
    });

    it('não sobe em produção com EMAIL_PROVEDOR=memoria', async () => {
      await expect(
        compilarCom({ ...PRODUCAO, EMAIL_PROVEDOR: 'memoria' }),
      ).rejects.toThrow(ConfiguracaoDeEmailInvalida);
    });

    it('em produção completa, a porta é a Resend', async () => {
      const modulo = await compilarCom(PRODUCAO);
      expect(modulo.get(PROVEDOR_DE_EMAIL)).toBeInstanceOf(
        ResendProvedorDeEmail,
      );
    });

    it('em teste, a porta é a memória, e o boot avisa', async () => {
      const modulo = await compilarCom({ NODE_ENV: 'test' });
      expect(modulo.get(PROVEDOR_DE_EMAIL)).toBeInstanceOf(
        MemoriaProvedorDeEmail,
      );
      expect(JSON.stringify(espioesDoLogger.warn.mock.calls)).toContain(
        'e-mail em memória',
      );
    });

    it('a chave da Resend não sai do módulo', async () => {
      const modulo = await compilarCom(PRODUCAO);
      const exportados = Reflect.getMetadata(
        MODULE_METADATA.EXPORTS,
        EmailModule,
      ) as unknown[];
      expect(exportados).toContain(PROVEDOR_DE_EMAIL);
      expect(exportados).toContain(CONFIGURACAO_DOS_MODELOS);
      expect(exportados).not.toContain(CONFIGURACAO_DE_EMAIL);

      const paraModelos = modulo.get<ConfiguracaoDosModelos>(
        CONFIGURACAO_DOS_MODELOS,
      );
      expect(paraModelos).toEqual({
        remetente: 'nao-responda@playck.com.br',
        responderPara: 'suporte@playck.com.br',
        urlCliente: 'https://app.playck.com.br',
        urlAdmin: 'https://admin.playck.com.br',
      });
      expect(JSON.stringify(paraModelos)).not.toContain('re_chave');
    });
  });
});
