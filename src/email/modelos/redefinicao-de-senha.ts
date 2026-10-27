import type { ConfiguracaoDosModelos } from '../email.config';
import { escaparHtml } from '../escapar-html';
import type { MensagemDeEmail } from '../provedor-de-email';
import { BANNER_DO_EMAIL } from './convite-de-acesso';
// Só o tipo, pela razão do `convite-de-acesso.ts`: o registro importa este
// arquivo.
import type { ModeloDeEmail } from './registro';

/**
 * SPEC-090/D8 — o modelo `redefinicao_de_senha`: o e-mail que leva o link
 * para a pessoa escolher uma senha nova, quando esqueceu a dela.
 *
 * **Nenhum nome de pessoa nem de clube**, no corpo, no assunto ou no
 * remetente: um e-mail pode cobrir contas em vários clubes (I2), e quem pediu
 * pode não ser o dono da caixa. O único dado variável é o número de contas, um
 * inteiro (`camposDePessoa = []`).
 */

/**
 * D8 — a validade do link. O texto do e-mail cita este número, e quem emite o
 * pedido calcula `expira_em` com ele: um lugar só para os dois não
 * divergirem. Uma hora, e não os 7 dias do convite: quem pede redefinição
 * está com o e-mail aberto agora.
 */
export const VALIDADE_DA_REDEFINICAO_EM_MINUTOS = 60;

/** "1 hora" para os 60 minutos de hoje; o número em minutos para outro valor. */
function textoDaValidade(minutos: number): string {
  return minutos === 60 ? '1 hora' : `${minutos} minutos`;
}

/**
 * D6 — **para que app o link aponta**, decidido pelo papel das contas do
 * pedido e nunca pela tela onde a pessoa pediu: gestor que pede pelo Cliente
 * recebe o link do Admin.
 */
export const DESTINOS_DA_REDEFINICAO = ['cliente', 'admin'] as const;
export type DestinoDaRedefinicao = (typeof DESTINOS_DA_REDEFINICAO)[number];

/**
 * D6/INV-090d — **o link sai da configuração e do papel, nunca da
 * requisição.** Três parâmetros, e nenhum é o `Request`: montar o link com o
 * `Host` de quem pediu é o *password reset poisoning* — um cabeçalho forjado
 * faria o e-mail legítimo do PlayCK levar o token para o servidor de outra
 * pessoa (S3, AC-008).
 */
export function montarLinkDeRedefinicao(
  config: Pick<ConfiguracaoDosModelos, 'urlCliente' | 'urlAdmin'>,
  destino: DestinoDaRedefinicao,
  token: string,
): string {
  const origem = destino === 'admin' ? config.urlAdmin : config.urlCliente;
  // O token é base64url e não muda aqui; o `encodeURIComponent` é o que
  // impede um token malformado de sair do segmento de caminho.
  return `${origem}/redefinir-senha/${encodeURIComponent(token)}`;
}

/** Um tipo, e não uma interface, para caber no registro (`Record`). */
export type DadosDaRedefinicaoDeSenha = {
  /** O id em `pedidos_de_redefinicao`: vira a chave de idempotência. */
  readonly pedidoId: string;
  /**
   * O token cru. Existe só em memória, entre a emissão e o envio, e nunca vai
   * a banco nem a log (INV-090g).
   */
  readonly token: string;
  /** O e-mail das contas do pedido. */
  readonly para: string;
  readonly destino: DestinoDaRedefinicao;
  /** Quantas contas o link cobre (≥ 1). Com duas ou mais, o texto avisa. */
  readonly quantidadeDeContas: number;
};

export function chaveDaRedefinicaoDeSenha(pedidoId: string): string {
  return `redefinicao-de-senha/${pedidoId}`;
}

export function renderizarRedefinicaoDeSenha(
  config: ConfiguracaoDosModelos,
  dados: DadosDaRedefinicaoDeSenha,
): MensagemDeEmail {
  const link = montarLinkDeRedefinicao(config, dados.destino, dados.token);
  // O banner é servido pelo Cliente mesmo no e-mail do gestor: é o único
  // lugar que o serve (`BANNER_DO_EMAIL`).
  const banner = `${config.urlCliente}${BANNER_DO_EMAIL.caminho}`;
  const validade = textoDaValidade(VALIDADE_DA_REDEFINICAO_EM_MINUTOS);
  // Um inteiro, e o `Math.trunc` garante que continua sendo: o número entra
  // no HTML sem escape porque não há texto nele.
  const contas = Math.trunc(dados.quantidadeDeContas);
  const variasContas =
    contas >= 2
      ? `Seu e-mail tem conta em ${contas} clubes. Ao abrir o link, escolha qual conta vai ter a senha redefinida.`
      : null;

  // O mesmo molde do convite (`convite-de-acesso.ts`): tabelas, estilo em
  // linha, **o banner como primeiro elemento visível** e nenhum `<style>`.
  //
  // **Mudar este HTML obriga a rever a cópia literal do `email.spec.ts`**
  // (AC-019): o teste exige este HTML exato nos dois ramos (uma conta, N
  // contas). **Ramo novo aqui pede cópia nova lá.**
  //
  // **O texto é só o da D8**, sem frase de apoio: o molde do convite é de
  // forma, não de texto. O endereço por extenso vem sozinho, sem o "Se o
  // botão não abrir…" do convite, e a saudação é um parágrafo só (revisão
  // REV-090-B04). Frase nova aqui é texto que a spec não aprovou.
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
<p style="margin:0 0 24px;">Olá. Recebemos um pedido para redefinir a senha da sua conta no PlayCK.</p>
<p style="margin:0 0 24px;"><a href="${escaparHtml(link)}" style="display:inline-block;padding:12px 24px;background-color:#18181b;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;">Redefinir minha senha</a></p>
<p style="margin:0 0 16px;font-size:14px;line-height:20px;color:#52525b;"><a href="${escaparHtml(link)}" style="color:#18181b;word-break:break-all;">${escaparHtml(link)}</a></p>
<p style="margin:0 0 16px;font-size:14px;line-height:20px;color:#52525b;">O link vale por ${validade} e só pode ser usado uma vez.</p>
${variasContas === null ? '' : `<p style="margin:0 0 16px;font-size:14px;line-height:20px;color:#52525b;">${variasContas}</p>\n`}<p style="margin:0;font-size:14px;line-height:20px;color:#52525b;">Se você não pediu, ignore este e-mail. Sua senha continua a mesma.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;

  // Completo sem a imagem, como o convite (LIM-083l).
  const text = [
    'Olá. Recebemos um pedido para redefinir a senha da sua conta no PlayCK.',
    '',
    link,
    '',
    `O link vale por ${validade} e só pode ser usado uma vez.`,
    '',
    ...(variasContas === null ? [] : [variasContas, '']),
    'Se você não pediu, ignore este e-mail. Sua senha continua a mesma.',
    '',
  ].join('\n');

  return {
    // Nenhum clube no remetente: o e-mail pode cobrir vários (D8).
    from: `"PlayCK" <${config.remetente}>`,
    to: dados.para,
    replyTo: config.responderPara,
    subject: 'Redefinir sua senha do PlayCK',
    html,
    text,
    chaveDeIdempotencia: chaveDaRedefinicaoDeSenha(dados.pedidoId),
  };
}

export const REDEFINICAO_DE_SENHA: ModeloDeEmail<DadosDaRedefinicaoDeSenha> = {
  nome: 'redefinicao_de_senha',
  renderizar: renderizarRedefinicaoDeSenha,
  // D8 — vazio de propósito: nenhum dado de pessoa entra neste e-mail.
  camposDePessoa: [],
  exemplo: {
    pedidoId: '00000000-0000-4000-8000-000000000090',
    token: 'cmVkZWZpbmljYW8tZGUtZXhlbXBsby0zMi1ieXRlczA',
    para: 'aluna@exemplo.com.br',
    destino: 'cliente',
    quantidadeDeContas: 1,
  },
};
