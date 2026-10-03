import type { ConfiguracaoDosModelos } from '../email.config';
import {
  escaparHtml,
  linhaUnica,
  nomeDoClubeNoRemetente,
} from '../escapar-html';
import type { MensagemDeEmail } from '../provedor-de-email';

/**
 * SPEC-083/D8 — o modelo `convite_de_acesso`: o e-mail que leva o link para a
 * pessoa criar a própria senha.
 */

/**
 * D6 — a validade do link, a mesma do convite e da senha temporária
 * (ADR-013). O texto do e-mail cita este número, e quem emite o convite
 * calcula `expira_em` com ele: um lugar só para os dois não divergirem.
 */
export const VALIDADE_DO_CONVITE_EM_DIAS = 7;

/**
 * I15 — o banner da PlayCK, **a única imagem** do e-mail. O arquivo é servido
 * pelo Cliente (`public/email/playck-banner.jpg`, 1200 × 427, conferido pelo
 * teste de lá, AC-044); aqui ficam o endereço e as medidas do HTML.
 *
 * A URL é a mesma para todo mundo e não leva parâmetro: não diz quem abriu.
 */
export const BANNER_DO_EMAIL = {
  caminho: '/email/playck-banner.jpg',
  largura: 600,
  altura: 213,
  alt: 'PlayCK — Mais que tênis, é conexão.',
} as const;

/**
 * D8/INV-083e — **o link sai da configuração, nunca da requisição.** A função
 * não recebe `Request` de propósito: montar o link com o `Host` de quem pediu
 * é o *password reset poisoning*, em que um cabeçalho forjado faz o e-mail
 * legítimo do PlayCK levar o token para o servidor de outra pessoa (S4,
 * AC-027).
 */
export function montarLinkDeAtivacao(
  config: Pick<ConfiguracaoDosModelos, 'urlCliente'>,
  token: string,
): string {
  // O token é base64url e não muda aqui; o `encodeURIComponent` é o que
  // impede um token malformado de sair do segmento de caminho.
  return `${config.urlCliente}/ativar/${encodeURIComponent(token)}`;
}

/** Um tipo, e não uma interface, para caber no registro (`Record`). */
export type DadosDoConviteDeAcesso = {
  /** O id em `convites_de_acesso`: vira a chave de idempotência. */
  readonly conviteId: string;
  /**
   * O token cru. Existe só em memória, entre a emissão e o envio, e nunca vai
   * a banco nem a log (INV-083f).
   */
  readonly token: string;
  /** Sempre `usuarios.email` (D9). */
  readonly para: string;
  readonly nomeDoClube: string;
  /** Como o gestor cadastrou. O modelo não corta. */
  readonly nomeDaPessoa: string;
};

export function chaveDoConviteDeAcesso(conviteId: string): string {
  return `convite-de-acesso/${conviteId}`;
}

export function renderizarConviteDeAcesso(
  config: ConfiguracaoDosModelos,
  dados: DadosDoConviteDeAcesso,
): MensagemDeEmail {
  const clube = linhaUnica(dados.nomeDoClube) || 'PlayCK';
  const pessoa = linhaUnica(dados.nomeDaPessoa);
  const link = montarLinkDeAtivacao(config, dados.token);
  const banner = `${config.urlCliente}${BANNER_DO_EMAIL.caminho}`;
  const saudacaoHtml = pessoa ? `Olá, ${escaparHtml(pessoa)}.` : 'Olá.';
  const saudacaoTexto = pessoa ? `Olá, ${pessoa}.` : 'Olá.';
  const validade = `${VALIDADE_DO_CONVITE_EM_DIAS} dias`;

  // Tabelas e estilo em linha porque é o que os programas de e-mail entendem.
  // **O banner é o primeiro elemento visível do corpo** (D8): antes dele só há
  // a cadeia de tabelas que o contém, nenhum texto — nem o "pré-cabeçalho"
  // escondido que muitos e-mails usam, que seria texto antes da imagem. E o
  // CSS fica **só no atributo `style`**, sem `<style>` no `<head>`: é o que
  // deixa o teste do AC-028 ver tudo o que se aplica ao banner, e as listas
  // fechadas dele dizem o que cada tag pode declarar.
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;">
<tr><td style="padding:0;"><img src="${escaparHtml(banner)}" width="${BANNER_DO_EMAIL.largura}" height="${BANNER_DO_EMAIL.altura}" alt="${escaparHtml(BANNER_DO_EMAIL.alt)}" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>
<tr><td style="padding:32px 28px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;color:#18181b;">
<p style="margin:0 0 16px;">${saudacaoHtml}</p>
<p style="margin:0 0 24px;"><strong>${escaparHtml(clube)}</strong> convidou você para o PlayCK. Crie a sua senha para entrar:</p>
<p style="margin:0 0 24px;"><a href="${escaparHtml(link)}" style="display:inline-block;padding:12px 24px;background-color:#18181b;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;">Criar minha senha</a></p>
<p style="margin:0 0 16px;font-size:14px;line-height:20px;color:#52525b;">Se o botão não abrir, copie este endereço no navegador:<br><a href="${escaparHtml(link)}" style="color:#18181b;word-break:break-all;">${escaparHtml(link)}</a></p>
<p style="margin:0 0 16px;font-size:14px;line-height:20px;color:#52525b;">O link vale por ${validade} e só pode ser usado uma vez.</p>
<p style="margin:0;font-size:14px;line-height:20px;color:#52525b;">Se você não esperava este convite, ignore este e-mail.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;

  // O e-mail é completo sem a imagem (D8): quem bloqueia imagem, ou lê só o
  // texto, recebe o mesmo convite e o mesmo link (LIM-083l).
  const text = [
    saudacaoTexto,
    '',
    `${clube} convidou você para o PlayCK. Crie a sua senha para entrar:`,
    '',
    link,
    '',
    `O link vale por ${validade} e só pode ser usado uma vez.`,
    '',
    'Se você não esperava este convite, ignore este e-mail.',
    '',
  ].join('\n');

  return {
    from: `"${nomeDoClubeNoRemetente(dados.nomeDoClube)} via PlayCK" <${config.remetente}>`,
    to: dados.para,
    replyTo: config.responderPara,
    subject: `${clube} convidou você para o PlayCK`,
    html,
    text,
    chaveDeIdempotencia: chaveDoConviteDeAcesso(dados.conviteId),
  };
}

/**
 * O contrato de todo modelo, e o que os testes do AC-028 e do AC-041 iteram.
 *
 * `renderizar` é método, e não propriedade com função, para o registro
 * aceitar modelos com dados de formatos diferentes.
 */
export interface ModeloDeEmail<
  Dados extends Record<string, string> = Record<string, string>,
> {
  readonly nome: string;
  renderizar(config: ConfiguracaoDosModelos, dados: Dados): MensagemDeEmail;
  /**
   * Os campos que vêm de pessoa (gestor, aluno, professor). Todos passam por
   * `escaparHtml()` no HTML, e o teste injeta em cada um, **um de cada vez**:
   * tirar o escape de um campo derruba só o caso daquele campo (S5).
   *
   * `string`, e não `keyof Dados`: o `keyof` tornaria o tipo invariante e o
   * registro recusaria o modelo. O teste confere que cada campo existe em
   * `exemplo`.
   */
  readonly camposDePessoa: readonly string[];
  /** Dados válidos, de onde o teste parte para trocar um campo. */
  readonly exemplo: Dados;
}

export const CONVITE_DE_ACESSO: ModeloDeEmail<DadosDoConviteDeAcesso> = {
  nome: 'convite_de_acesso',
  renderizar: renderizarConviteDeAcesso,
  camposDePessoa: ['nomeDoClube', 'nomeDaPessoa'],
  exemplo: {
    conviteId: '00000000-0000-4000-8000-000000000001',
    token: 'dG9rZW4tZGUtZXhlbXBsby1kZS0zMi1ieXRlcy1hYmM',
    para: 'aluna@exemplo.com.br',
    nomeDoClube: 'Clube Exemplo',
    nomeDaPessoa: 'Maria Souza',
  },
};

/**
 * **O registro, mesmo com um modelo só.** Um modelo novo entra aqui e herda,
 * sem teste novo, as provas de escape, remetente, banner e imagem única.
 * Mora neste arquivo enquanto há um modelo; com o segundo, vale um arquivo
 * próprio.
 */
export const MODELOS_DE_EMAIL: readonly ModeloDeEmail[] = [CONVITE_DE_ACESSO];
