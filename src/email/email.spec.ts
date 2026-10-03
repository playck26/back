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
  MODELOS_DE_EMAIL,
  montarLinkDeAtivacao,
  renderizarConviteDeAcesso,
  VALIDADE_DO_CONVITE_EM_DIAS,
  type DadosDoConviteDeAcesso,
} from './modelos/convite-de-acesso';
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
  TEMPO_MAXIMO_POR_CHAMADA_MS,
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
};

const TOKEN = CONVITE_DE_ACESSO.exemplo.token;

/** Os dois valores hostis do AC-028, exatamente como a spec os escreve. */
const INJECAO_DE_HTML = '"><a href="https://x">clique</a>';
const INJECAO_DE_CABECALHO = '\r\nBcc: x@x';

function convite(
  trocas: Partial<DadosDoConviteDeAcesso> = {},
): DadosDoConviteDeAcesso {
  return { ...CONVITE_DE_ACESSO.exemplo, ...trocas };
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

function atributo(tag: string, nome: string): string | null {
  return new RegExp(`\\s${nome}="([^"]*)"`).exec(tag)?.[1] ?? null;
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

describe('AC-028 — o modelo, com nome hostil de clube e de pessoa', () => {
  it('cada campo de pessoa declarado existe nos dados do modelo', () => {
    for (const modelo of MODELOS_DE_EMAIL) {
      expect(modelo.camposDePessoa.length).toBeGreaterThan(0);
      for (const campo of modelo.camposDePessoa) {
        expect(Object.keys(modelo.exemplo)).toContain(campo);
      }
    }
  });

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

  it('são 4 casos hoje: 1 modelo × 2 campos × 2 valores', () => {
    expect(casos).toHaveLength(4);
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
    '%s: a única imagem é o banner, primeiro elemento visível do corpo',
    (_nome, modelo) => {
      const { html, text } = modelo.renderizar(CONFIG, modelo.exemplo);

      const imagens = html.match(/<img\b[^>]*>/gi) ?? [];
      expect(imagens).toHaveLength(1);
      const banner = imagens[0] ?? '';
      expect(atributo(banner, 'src')).toBe(
        'https://app.playck.com.br/email/playck-banner.jpg',
      );
      expect(atributo(banner, 'src')).not.toContain('?');
      expect(atributo(banner, 'width')).toBe('600');
      expect(atributo(banner, 'height')).toBe('213');
      expect(atributo(banner, 'alt')).toBe(
        'PlayCK — Mais que tênis, é conexão.',
      );
      expect(BANNER_DO_EMAIL.alt).toBe('PlayCK — Mais que tênis, é conexão.');

      // Primeiro elemento visível: entre o `<body>` e o `<img>` só há
      // estrutura. Tiradas as tags, não sobra nenhum texto — nem pré-cabeçalho
      // escondido, nem `&nbsp;`.
      const corpo = html.slice(html.indexOf('<body'));
      const antesDoBanner = corpo.slice(0, corpo.indexOf('<img'));
      expect(corpo.indexOf('<img')).toBeGreaterThan(0);
      expect(antesDoBanner.replace(/<[^>]*>/g, '').trim()).toBe('');

      // Nenhum pixel nem outra imagem por outro caminho.
      expect(html).not.toMatch(/url\(|background=|<picture|<svg|<iframe/i);
      expect(text).not.toContain('<img');
    },
  );
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
    '%s: todo modelo usa EMAIL_REMETENTE e EMAIL_RESPONDER_PARA da configuração',
    (_nome, modelo) => {
      const outra = {
        ...CONFIG,
        remetente: 'outro@exemplo.com',
        responderPara: 'ajuda@exemplo.com',
      };
      const mensagem = modelo.renderizar(outra, modelo.exemplo);
      expect(mensagem.from).toMatch(/ via PlayCK" <outro@exemplo\.com>$/);
      expect(mensagem.replyTo).toBe('ajuda@exemplo.com');
    },
  );

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

describe('o tempo máximo de 10 s por chamada', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('avulso que não responde vira tempo_esgotado, e o pedido é abortado', async () => {
    const { cliente, emails } = dubleDoResend();
    let sinal: AbortSignal | undefined;
    emails.mockImplementation((_pedido, opcoes) => {
      sinal = opcoes.signal;
      return new Promise(() => undefined);
    });
    const provedor = new ResendProvedorDeEmail(cliente);
    let resolveu = false;
    const resultado = provedor.enviar(mensagens(1)[0]).then((r) => {
      resolveu = true;
      return r;
    });

    await jest.advanceTimersByTimeAsync(TEMPO_MAXIMO_POR_CHAMADA_MS - 1);
    expect(resolveu).toBe(false);
    expect(sinal?.aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    await expect(resultado).resolves.toEqual({
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
    const resultado = provedor.enviar(mensagens(1)[0]);

    await jest.advanceTimersByTimeAsync(TEMPO_MAXIMO_POR_CHAMADA_MS);
    await expect(resultado).resolves.toEqual({
      ok: false,
      motivo: 'tempo_esgotado',
    });
  });

  it('bloco que não responde: as mensagens dele saem tempo_esgotado, e o próximo bloco ainda sai', async () => {
    const { cliente, lote } = dubleDoResend();
    lote
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockImplementationOnce(loteAceito('segundo'));
    const provedor = new ResendProvedorDeEmail(cliente);
    const resultado = provedor.enviarLote(mensagens(150));

    await jest.advanceTimersByTimeAsync(TEMPO_MAXIMO_POR_CHAMADA_MS);
    const resultados = await resultado;

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
      await jest.advanceTimersByTimeAsync(TEMPO_MAXIMO_POR_CHAMADA_MS);
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
  const PRODUCAO: Record<string, string> = {
    NODE_ENV: 'production',
    EMAIL_PROVEDOR: 'resend',
    RESEND_API_KEY: 're_chave_so_de_envio',
    EMAIL_REMETENTE: 'nao-responda@playck.com.br',
    EMAIL_RESPONDER_PARA: 'suporte@playck.com.br',
    URL_CLIENTE: 'https://app.playck.com.br',
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
    });
  });

  it.each<[string, Record<string, string | undefined>]>([
    ['EMAIL_PROVEDOR=memoria', { EMAIL_PROVEDOR: 'memoria' }],
    ['EMAIL_PROVEDOR ausente', { EMAIL_PROVEDOR: undefined }],
    ['EMAIL_PROVEDOR desconhecido', { EMAIL_PROVEDOR: 'smtp' }],
    ['sem RESEND_API_KEY', { RESEND_API_KEY: undefined }],
    ['RESEND_API_KEY em branco', { RESEND_API_KEY: '   ' }],
    ['RESEND_API_KEY com quebra de linha', { RESEND_API_KEY: 're_a\nb' }],
    ['sem EMAIL_RESPONDER_PARA', { EMAIL_RESPONDER_PARA: undefined }],
    ['EMAIL_RESPONDER_PARA sem @', { EMAIL_RESPONDER_PARA: 'suporte' }],
    [
      'EMAIL_RESPONDER_PARA com nome de exibição',
      { EMAIL_RESPONDER_PARA: 'Suporte <suporte@playck.com.br>' },
    ],
    [
      'EMAIL_RESPONDER_PARA com cabeçalho injetado',
      { EMAIL_RESPONDER_PARA: 'suporte@playck.com.br\r\nBcc: x@x' },
    ],
    ['sem EMAIL_REMETENTE', { EMAIL_REMETENTE: undefined }],
    ['EMAIL_REMETENTE inválido', { EMAIL_REMETENTE: 'nao-responda' }],
    ['sem URL_CLIENTE', { URL_CLIENTE: undefined }],
    ['URL_CLIENTE sem https', { URL_CLIENTE: 'http://app.playck.com.br' }],
    [
      'URL_CLIENTE com caminho',
      { URL_CLIENTE: 'https://app.playck.com.br/cliente' },
    ],
    [
      'URL_CLIENTE com query',
      { URL_CLIENTE: 'https://app.playck.com.br/?x=1' },
    ],
    ['URL_CLIENTE relativa', { URL_CLIENTE: 'app.playck.com.br' }],
  ])('em produção, recusa %s', (_rotulo, trocas) => {
    expect(() => carregarEmailConfig(emProducao(trocas))).toThrow(
      ConfiguracaoDeEmailInvalida,
    );
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
    });
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
      });
      expect(JSON.stringify(paraModelos)).not.toContain('re_chave');
    });
  });
});
