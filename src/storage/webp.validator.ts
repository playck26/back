/**
 * SPEC-017/TASK-002 — validador de WebP.
 *
 * **O servidor não decodifica imagem** (INV-033/NFR-001). A API roda em
 * 512 MB; uma foto de 12 MP decodifica para ~36 MB de pixels crus, e três
 * uploads simultâneos derrubam o container — no App Platform, isso é a API
 * inteira reiniciando. Tudo aqui é leitura de cabeçalho.
 *
 * **E a recusa é allowlist, não blocklist.** Listar `EXIF`/`XMP`/`ANIM`
 * deixaria passar chunk desconhecido ou customizado com dado arbitrário, e
 * o formato permite os dois. Passam quatro chunks; o resto recusa,
 * inclusive o que ninguém previu. Blocklist protege do que se conhece;
 * allowlist, do que não se conhece.
 *
 * **A função é total** (AC-005): entrada nenhuma faz ela lançar. Exceção
 * viraria 500 numa rota que deve responder 422 — caminho novo de falha.
 */

/** AC-004. Fronteira inclusiva: 2500 passa, 2501 não. */
export const LIMITE_DE_DIMENSAO_PX = 2500;

/**
 * AC-002 — os quatro FourCC que passam. `VP8 ` e `ALPH` têm espaço no fim;
 * o formato é de 4 bytes e a comparação é **byte a byte**, case-sensitive:
 * `vp8 ` não é `VP8 `.
 */
const CHUNKS_PERMITIDOS = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH']);

/**
 * Bits do byte de flags do `VP8X`, na ordem do container spec:
 * `Rsv(2) | I(ICC) | L(Alpha) | E(Exif) | X(XMP) | A(Animação) | R`.
 *
 * Só `Alpha` é aceitável — é o par do chunk `ALPH`, que está na allowlist.
 * Os outros **anunciam metadado**, e um arquivo que anuncia EXIF é recusado
 * mesmo que o chunk não esteja lá: o container mentindo sobre si mesmo já é
 * motivo bastante, e a AC-003 manda recusar pelo flag, não só pelo chunk.
 */
const FLAG_ICC = 0x20;
const FLAG_EXIF = 0x08;
const FLAG_XMP = 0x04;
const FLAG_ANIMACAO = 0x02;
const FLAGS_PROIBIDOS = FLAG_ICC | FLAG_EXIF | FLAG_XMP | FLAG_ANIMACAO;

const CABECALHO_RIFF = 12;
const TAMANHO_PAYLOAD_VP8X = 10;

/**
 * Motivo devolvido pelo `catch` de último recurso do `validarWebp`. É
 * exportado para o teste poder provar que ele **nunca dispara** no corpus:
 * cinto de segurança que dispara em uso normal está escondendo defeito, e
 * mascara mutação — foi o que aconteceu na 3ª bateria deste ciclo.
 */
export const MOTIVO_ILEGIVEL = 'arquivo ilegível';

export type CodigoDeRecusa =
  'TIPO_NAO_SUPORTADO' | 'IMAGEM_COM_METADADOS' | 'IMAGEM_GRANDE_DEMAIS';

export type FormatoWebp = 'VP8' | 'VP8L' | 'VP8X';

export type ResultadoDaValidacao =
  | {
      readonly valido: true;
      readonly formato: FormatoWebp;
      readonly largura: number;
      readonly altura: number;
    }
  | {
      readonly valido: false;
      readonly codigo: CodigoDeRecusa;
      /** Curto e sem conteúdo do arquivo: isto vai para log e resposta. */
      readonly motivo: string;
    };

function recusa(codigo: CodigoDeRecusa, motivo: string): ResultadoDaValidacao {
  return { valido: false, codigo, motivo };
}

const NAO_E_WEBP = (motivo: string) => recusa('TIPO_NAO_SUPORTADO', motivo);
const TEM_METADADO = (motivo: string) => recusa('IMAGEM_COM_METADADOS', motivo);

interface ChunkLido {
  readonly fourcc: string;
  readonly inicio: number;
  readonly tamanho: number;
}

export function validarWebp(corpo: Buffer): ResultadoDaValidacao {
  try {
    return analisar(corpo);
  } catch {
    // Cinto de segurança do fail-closed, e não a defesa principal: o
    // `analisar` confere limite antes de cada leitura. Se ainda assim
    // escapar alguma, o resultado é recusa — nunca 500, nunca "passou".
    return NAO_E_WEBP(MOTIVO_ILEGIVEL);
  }
}

function analisar(corpo: Buffer): ResultadoDaValidacao {
  if (corpo.length === 0) {
    return NAO_E_WEBP('arquivo vazio');
  }
  if (corpo.length < CABECALHO_RIFF) {
    return NAO_E_WEBP('arquivo curto demais para ter cabeçalho RIFF');
  }
  if (corpo.toString('latin1', 0, 4) !== 'RIFF') {
    return NAO_E_WEBP('não começa com RIFF');
  }
  if (corpo.toString('latin1', 8, 12) !== 'WEBP') {
    return NAO_E_WEBP('container RIFF que não é WEBP');
  }

  // O RIFF declara o próprio tamanho. Declarar MAIOR é arquivo truncado;
  // declarar MENOR é byte sobrando depois do fim — e byte sobrando num
  // upload é exatamente o que ninguém consegue explicar depois.
  const tamanhoDeclarado = corpo.readUInt32LE(4);
  if (tamanhoDeclarado !== corpo.length - 8) {
    return NAO_E_WEBP('tamanho declarado no RIFF não bate com o arquivo');
  }

  const chunks = lerChunks(corpo);
  if (chunks === null) {
    return NAO_E_WEBP('cadeia de chunks truncada ou malformada');
  }
  if (chunks.length === 0) {
    return NAO_E_WEBP('nenhum chunk depois do cabeçalho');
  }

  for (const { fourcc } of chunks) {
    if (!CHUNKS_PERMITIDOS.has(fourcc)) {
      // O nome do chunk é FourCC, não conteúdo — pode ir para o log.
      return TEM_METADADO(`chunk não permitido: ${sanitizar(fourcc)}`);
    }
  }

  const vp8x = chunks.find((c) => c.fourcc === 'VP8X');
  if (vp8x) {
    return validarEstendido(corpo, vp8x);
  }

  const principal = chunks[0];
  if (principal.fourcc === 'VP8 ') {
    return comDimensao('VP8', lerDimensaoVp8(corpo, principal));
  }
  if (principal.fourcc === 'VP8L') {
    return comDimensao('VP8L', lerDimensaoVp8l(corpo, principal));
  }
  return NAO_E_WEBP('sem chunk de imagem');
}

/**
 * Percorre a cadeia de chunks. Devolve `null` — e não lança, e não devolve
 * o que conseguiu ler — em qualquer malformação: um parser que entrega
 * resultado parcial de arquivo quebrado é um parser permissivo.
 */
function lerChunks(corpo: Buffer): ChunkLido[] | null {
  const chunks: ChunkLido[] = [];
  let i = CABECALHO_RIFF;

  while (i < corpo.length) {
    if (i + 8 > corpo.length) {
      return null; // acabou no meio do cabeçalho do chunk
    }
    const fourcc = corpo.toString('latin1', i, i + 4);
    const tamanho = corpo.readUInt32LE(i + 4);
    const fimDoPayload = i + 8 + tamanho;

    // O clássico do parser que confia no tamanho declarado e lê fora do
    // buffer. **Esta linha é o que segura a leniência logo abaixo:** sem
    // ela, um chunk que declara mais do que o arquivo tem cai no ramo do
    // padding e seria ACEITO como último chunk de um arquivo truncado.
    // (Descoberto por mutação: a primeira versão tinha as duas checagens
    // redundantes, e apagar esta não reprovava teste nenhum.)
    if (fimDoPayload > corpo.length) {
      return null;
    }

    chunks.push({ fourcc, inicio: i + 8, tamanho });

    // Chunk de tamanho ímpar leva um byte de padding. No ÚLTIMO chunk,
    // encoder que omite esse byte é tolerado — a única leniência daqui, e
    // só chega nela quem já provou que o payload inteiro cabe.
    const proximo = fimDoPayload + (tamanho % 2);
    if (proximo > corpo.length) {
      return chunks;
    }
    i = proximo;
  }

  return chunks;
}

function validarEstendido(
  corpo: Buffer,
  vp8x: ChunkLido,
): ResultadoDaValidacao {
  if (vp8x.tamanho !== TAMANHO_PAYLOAD_VP8X) {
    return NAO_E_WEBP('cabeçalho VP8X com tamanho errado');
  }
  const flags = corpo[vp8x.inicio];
  if ((flags & FLAGS_PROIBIDOS) !== 0) {
    // AC-003: o bit de animação recusa mesmo sem chunk `ANIM`. Quem varre
    // chunk e ignora flag deixa passar um arquivo que se declara animado.
    return TEM_METADADO(
      `VP8X anuncia ${nomesDosFlags(flags).join(', ')} no flag`,
    );
  }
  const largura = lerUInt24LE(corpo, vp8x.inicio + 4) + 1;
  const altura = lerUInt24LE(corpo, vp8x.inicio + 7) + 1;
  return comDimensao('VP8X', { largura, altura });
}

/** `VP8 `: 3 bytes de frame tag, o sync code `9D 01 2A`, e as dimensões. */
function lerDimensaoVp8(
  corpo: Buffer,
  chunk: ChunkLido,
): Dimensao | CodigoDeRecusa {
  if (chunk.tamanho < 10) {
    return 'TIPO_NAO_SUPORTADO';
  }
  const p = chunk.inicio;
  const ehKeyframe = (corpo[p] & 1) === 0;
  const sync =
    corpo[p + 3] === 0x9d && corpo[p + 4] === 0x01 && corpo[p + 5] === 0x2a;
  if (!ehKeyframe || !sync) {
    return 'TIPO_NAO_SUPORTADO';
  }
  return {
    largura: corpo.readUInt16LE(p + 6) & 0x3fff,
    altura: corpo.readUInt16LE(p + 8) & 0x3fff,
  };
}

/** `VP8L`: byte de assinatura `0x2F` e 14 bits para cada dimensão, menos 1. */
function lerDimensaoVp8l(
  corpo: Buffer,
  chunk: ChunkLido,
): Dimensao | CodigoDeRecusa {
  if (chunk.tamanho < 5 || corpo[chunk.inicio] !== 0x2f) {
    return 'TIPO_NAO_SUPORTADO';
  }
  const bits = corpo.readUInt32LE(chunk.inicio + 1);
  return {
    largura: (bits & 0x3fff) + 1,
    altura: ((bits >>> 14) & 0x3fff) + 1,
  };
}

interface Dimensao {
  readonly largura: number;
  readonly altura: number;
}

function comDimensao(
  formato: FormatoWebp,
  dimensao: Dimensao | CodigoDeRecusa,
): ResultadoDaValidacao {
  if (typeof dimensao === 'string') {
    return NAO_E_WEBP('cabeçalho de imagem malformado');
  }
  const { largura, altura } = dimensao;
  if (largura <= 0 || altura <= 0) {
    return NAO_E_WEBP('dimensão inválida');
  }
  if (largura > LIMITE_DE_DIMENSAO_PX || altura > LIMITE_DE_DIMENSAO_PX) {
    return recusa(
      'IMAGEM_GRANDE_DEMAIS',
      `${largura}x${altura} passa de ${LIMITE_DE_DIMENSAO_PX}px`,
    );
  }
  return { valido: true, formato, largura, altura };
}

function lerUInt24LE(corpo: Buffer, offset: number): number {
  return corpo[offset] | (corpo[offset + 1] << 8) | (corpo[offset + 2] << 16);
}

function nomesDosFlags(flags: number): string[] {
  const nomes: string[] = [];
  if (flags & FLAG_ANIMACAO) nomes.push('animação');
  if (flags & FLAG_EXIF) nomes.push('EXIF');
  if (flags & FLAG_XMP) nomes.push('XMP');
  if (flags & FLAG_ICC) nomes.push('ICC');
  return nomes;
}

/** FourCC vem do arquivo; qualquer byte pode estar ali. */
function sanitizar(fourcc: string): string {
  return fourcc.replace(/[^\x20-\x7e]/g, '?');
}
