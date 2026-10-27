import type { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { isEmail } from 'class-validator';

/**
 * SPEC-083/D8 — configuração do MOD-015 (e-mail), no molde do
 * `storage.config.ts`: lida **uma vez, no boot**, e o app não sobe com ela
 * errada.
 *
 * **Com uma diferença deliberada: fora de produção há padrões.** O Spaces não
 * tem, porque o CI e cada `.env` local já trazem as seis variáveis. As de
 * e-mail são novas e nenhum ambiente de teste as tem; sem padrão, o merge
 * derrubaria toda suíte que sobe o `AppModule`. O padrão é o provedor memória,
 * que não envia nada.
 *
 * **Em produção, nenhum padrão** (AC-030). Faltando variável, a instância nova
 * não sobe e a antiga continua atendendo (State 13): o deploy falha sem
 * derrubar nada. É o oposto do push, que nasce desligado: push desligado não
 * mente, e um provedor memória em produção marcaria `enviado` em convite que
 * nunca saiu.
 */
export const CONFIGURACAO_DE_EMAIL = Symbol('CONFIGURACAO_DE_EMAIL');

/** A parte sem segredo, que o módulo exporta para quem renderiza modelo. */
export const CONFIGURACAO_DOS_MODELOS = Symbol('CONFIGURACAO_DOS_MODELOS');

export const PROVEDORES_DE_EMAIL = ['resend', 'memoria'] as const;
export type NomeDoProvedorDeEmail = (typeof PROVEDORES_DE_EMAIL)[number];

export interface ConfiguracaoDosModelos {
  /** Endereço puro: o modelo monta `"<clube> via PlayCK" <remetente>`. */
  readonly remetente: string;
  readonly responderPara: string;
  /** A origem do Cliente, sem barra final: base do link e do banner. */
  readonly urlCliente: string;
  /**
   * SPEC-090/D6 — a origem do Admin, sem barra final: base do link de
   * redefinição de senha do gestor. **Obrigatória**, como a do Cliente: com
   * um campo opcional, um literal tipado sem ela compilaria, e o link do
   * gestor sairia sem origem.
   */
  readonly urlAdmin: string;
}

/**
 * A chave existe se, e só se, o provedor é a Resend: o tipo não deixa o módulo
 * cair no provedor memória por falta dela. Ela é segredo, e não sai do
 * `EmailModule`.
 */
export type ConfiguracaoDeEmail = ConfiguracaoDosModelos &
  (
    | { readonly provedor: 'resend'; readonly chaveDoResend: string }
    | { readonly provedor: 'memoria'; readonly chaveDoResend: null }
  );

export const VARIAVEIS_DE_EMAIL = [
  'EMAIL_PROVEDOR',
  'RESEND_API_KEY',
  'EMAIL_REMETENTE',
  'EMAIL_RESPONDER_PARA',
  'URL_CLIENTE',
  'URL_ADMIN',
] as const;

/**
 * Fora de produção, e só lá. Os endereços são os da I13, os mesmos que
 * produção usa; `localhost:3003` é onde o Cliente roda localmente (o
 * `NEXT_PUBLIC_CLIENTE_URL` do Admin no `HANDOFF.md`), e `localhost:3001` é
 * onde o Admin roda (SPEC-090/D6).
 */
export const PADROES_FORA_DE_PRODUCAO = {
  EMAIL_PROVEDOR: 'memoria',
  EMAIL_REMETENTE: 'nao-responda@playck.com.br',
  EMAIL_RESPONDER_PARA: 'suporte@playck.com.br',
  URL_CLIENTE: 'http://localhost:3003',
  URL_ADMIN: 'http://localhost:3001',
} as const;

export class ConfiguracaoDeEmailInvalida extends Error {
  constructor(motivo: string) {
    super(`Configuração de e-mail inválida (SPEC-083/D8): ${motivo}`);
    this.name = 'ConfiguracaoDeEmailInvalida';
  }
}

/**
 * Nunca ecoa o valor, pela razão do storage: uma destas variáveis é a chave da
 * Resend, e mensagem de boot vai para log agregado. O nome já diz o que
 * corrigir.
 */
function lida(config: ConfigService, nome: string): string | null {
  const valor = config.get<string>(nome);
  if (typeof valor !== 'string' || valor.trim() === '') {
    return null;
  }
  return valor.trim();
}

function endereco(nome: string, valor: string): string {
  // `isEmail` recusa espaço, quebra de linha e o formato `Nome <x@y>`: o
  // remetente vira cabeçalho, e o nome de exibição é o modelo que monta.
  if (!isEmail(valor)) {
    throw new ConfiguracaoDeEmailInvalida(`${nome} não é um endereço válido`);
  }
  return valor;
}

/**
 * D8 — em produção, `https://` e sem caminho. Em qualquer ambiente, sem query,
 * sem fragmento e sem credencial: o link é `URL_CLIENTE + '/ativar/' + token`,
 * e qualquer um dos três o quebraria.
 *
 * SPEC-090/D6 — **generalizada, e não copiada**: a `URL_ADMIN` passa pela
 * mesma regra, e o nome da variável vai na mensagem para quem lê o log do
 * boot saber qual das duas corrigir. Uma cópia por variável divergiria na
 * primeira revisão de uma delas.
 */
function origem(
  nome: 'URL_CLIENTE' | 'URL_ADMIN',
  valor: string,
  producao: boolean,
): string {
  let url: URL;
  try {
    url = new URL(valor);
  } catch {
    throw new ConfiguracaoDeEmailInvalida(`${nome} não é uma URL absoluta`);
  }
  if (producao && url.protocol !== 'https:') {
    throw new ConfiguracaoDeEmailInvalida(
      `${nome} precisa ser https em produção`,
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfiguracaoDeEmailInvalida(`${nome} precisa ser http(s)`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConfiguracaoDeEmailInvalida(
      `${nome} não pode ter usuário nem senha`,
    );
  }
  // No texto, e não em `url.search`: `https://x/?` tem `search` vazio.
  if (valor.includes('?') || valor.includes('#')) {
    throw new ConfiguracaoDeEmailInvalida(
      `${nome} não pode ter query nem fragmento`,
    );
  }
  const caminho = url.pathname.replace(/\/+$/, '');
  if (producao && caminho !== '') {
    throw new ConfiguracaoDeEmailInvalida(
      `${nome} não pode ter caminho em produção`,
    );
  }
  // Sem barra final: quem monta o link concatena `/ativar/` ou
  // `/redefinir-senha/`.
  return `${url.protocol}//${url.host}${caminho}`;
}

export function carregarEmailConfig(
  config: ConfigService,
): ConfiguracaoDeEmail {
  const producao = config.get<string>('NODE_ENV') === 'production';

  const valor = (nome: keyof typeof PADROES_FORA_DE_PRODUCAO): string => {
    const lido = lida(config, nome);
    if (lido !== null) {
      return lido;
    }
    if (producao) {
      throw new ConfiguracaoDeEmailInvalida(
        `${nome} ausente ou vazia (obrigatória em produção)`,
      );
    }
    return PADROES_FORA_DE_PRODUCAO[nome];
  };

  const provedorLido = valor('EMAIL_PROVEDOR');
  const provedor = PROVEDORES_DE_EMAIL.find((nome) => nome === provedorLido);
  if (!provedor) {
    throw new ConfiguracaoDeEmailInvalida(
      'EMAIL_PROVEDOR precisa ser resend ou memoria',
    );
  }
  if (producao && provedor !== 'resend') {
    throw new ConfiguracaoDeEmailInvalida(
      'EMAIL_PROVEDOR=memoria não é aceito em produção: nenhum convite sairia',
    );
  }

  const enderecos: ConfiguracaoDosModelos = {
    remetente: endereco('EMAIL_REMETENTE', valor('EMAIL_REMETENTE')),
    responderPara: endereco(
      'EMAIL_RESPONDER_PARA',
      valor('EMAIL_RESPONDER_PARA'),
    ),
    urlCliente: origem('URL_CLIENTE', valor('URL_CLIENTE'), producao),
    urlAdmin: origem('URL_ADMIN', valor('URL_ADMIN'), producao),
  };

  if (provedor === 'memoria') {
    return { ...enderecos, provedor, chaveDoResend: null };
  }

  const chaveDoResend = lida(config, 'RESEND_API_KEY');
  if (chaveDoResend === null) {
    throw new ConfiguracaoDeEmailInvalida(
      'RESEND_API_KEY ausente ou vazia (obrigatória com EMAIL_PROVEDOR=resend)',
    );
  }
  // Colada do painel com uma quebra de linha no meio, ela só falharia no
  // primeiro envio, como `configuracao`, e o gestor veria `falhou`.
  if (/\s/.test(chaveDoResend)) {
    throw new ConfiguracaoDeEmailInvalida(
      'RESEND_API_KEY tem espaço ou quebra de linha',
    );
  }
  return { ...enderecos, provedor, chaveDoResend };
}

/**
 * Uma vez, no boot, e sem valor nenhum. O provedor memória sai em `warn`
 * porque é o único modo em que o produto diz `enviado` sem ter enviado: fora
 * de produção é o esperado, e o aviso é o que denuncia um ambiente que deveria
 * estar enviando e não está.
 */
export function registrarEmailNoBoot(
  config: ConfiguracaoDeEmail,
  logger: Logger,
): void {
  if (config.provedor === 'memoria') {
    logger.warn(
      'e-mail em memória: nenhum convite sai deste processo (EMAIL_PROVEDOR=memoria, ou ausente fora de produção).',
    );
    return;
  }
  logger.log('e-mail pela Resend.');
}
