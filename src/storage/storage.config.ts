import { ConfigService } from '@nestjs/config';

/**
 * SPEC-017/TASK-001 — configuração do fornecedor de storage.
 *
 * Fornecedor decidido na ADR-015: bucket próprio `playck-media` no
 * DigitalOcean Spaces, com chave **Limited Access** restrita a ele. Custo
 * marginal zero, porque a assinatura do Spaces é por conta, não por bucket.
 *
 * As seis variáveis são lidas **uma vez, no boot**, e o app não sobe com
 * qualquer uma delas faltando ou malformada. Fail-fast aqui é barato;
 * descobrir endpoint errado no primeiro upload de uma foto de aluno, não.
 */
export const STORAGE_CONFIG = Symbol('STORAGE_CONFIG');

export interface StorageConfig {
  /** Região do Spaces (ex.: `nyc3`). */
  readonly region: string;
  /** Endpoint REGIONAL, sem o bucket (ex.: `https://nyc3.digitaloceanspaces.com`). */
  readonly endpoint: string;
  readonly bucket: string;
  /** Base do CDN, sem barra final. */
  readonly cdnUrl: string;
  readonly key: string;
  readonly secret: string;
}

/** AC-010 — URL assinada expira em 15 minutos. */
export const EXPIRACAO_URL_ASSINADA_SEGUNDOS = 15 * 60;

/**
 * LIM-005 — o cache de terceiros é incontrolável; o que controlamos é o
 * nosso. Uma hora no público basta porque a chave é o conteúdo (AC-007):
 * trocar a imagem gera chave nova, e a antiga deixa de ser apontada.
 */
export const CACHE_CONTROL_PUBLICO = 'public, max-age=3600';

/**
 * No privado o cache morre junto com a assinatura: guardar por mais tempo
 * que a URL vive não serve para nada e espalha foto de pessoa por cache
 * intermediário. `private` mantém a cópia no navegador de quem viu, e só.
 */
export const CACHE_CONTROL_PRIVADO = 'private, max-age=900';

export const VARIAVEIS_DE_STORAGE = [
  'SPACES_REGION',
  'SPACES_ENDPOINT',
  'SPACES_BUCKET',
  'SPACES_CDN_URL',
  'SPACES_KEY',
  'SPACES_SECRET',
] as const;

export class ConfiguracaoDeStorageInvalida extends Error {
  constructor(motivo: string) {
    super(`Configuração de storage inválida (SPEC-017/ADR-015): ${motivo}`);
    this.name = 'ConfiguracaoDeStorageInvalida';
  }
}

/**
 * Nunca ecoa o valor: metade destas variáveis é segredo, e mensagem de
 * boot vai para log agregado. O nome da variável já diz o que corrigir.
 */
function obrigatoria(config: ConfigService, nome: string): string {
  const valor = config.get<string>(nome);
  if (typeof valor !== 'string' || valor.trim() === '') {
    throw new ConfiguracaoDeStorageInvalida(`${nome} ausente ou vazia`);
  }
  return valor.trim();
}

function urlAbsoluta(nome: string, valor: string): URL {
  let url: URL;
  try {
    url = new URL(valor);
  } catch {
    throw new ConfiguracaoDeStorageInvalida(`${nome} não é uma URL absoluta`);
  }
  if (url.protocol !== 'https:') {
    throw new ConfiguracaoDeStorageInvalida(`${nome} precisa ser https`);
  }
  return url;
}

export function carregarStorageConfig(config: ConfigService): StorageConfig {
  const region = obrigatoria(config, 'SPACES_REGION');
  const bucket = obrigatoria(config, 'SPACES_BUCKET');
  const endpointBruto = obrigatoria(config, 'SPACES_ENDPOINT');
  const cdnBruto = obrigatoria(config, 'SPACES_CDN_URL');

  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new ConfiguracaoDeStorageInvalida(
      'SPACES_BUCKET não é um nome de bucket válido',
    );
  }

  const endpoint = urlAbsoluta('SPACES_ENDPOINT', endpointBruto);

  // Armadilha do Spaces, e a razão desta checagem existir: o painel da
  // DigitalOcean mostra o endpoint JÁ com o bucket na frente
  // (`playck-media.nyc3.digitaloceanspaces.com`). Copiar aquilo para cá,
  // com o cliente em virtual-host style, produz
  // `playck-media.playck-media.nyc3...` — um host que nem existe. O erro
  // aparece só na primeira chamada real, como DNS quebrado, e não parece
  // erro de configuração nenhum.
  if (endpoint.hostname.startsWith(`${bucket}.`)) {
    throw new ConfiguracaoDeStorageInvalida(
      'SPACES_ENDPOINT contém o nome do bucket; use o endpoint regional',
    );
  }
  if (endpoint.pathname !== '/' && endpoint.pathname !== '') {
    throw new ConfiguracaoDeStorageInvalida(
      'SPACES_ENDPOINT não pode ter caminho',
    );
  }

  urlAbsoluta('SPACES_CDN_URL', cdnBruto);

  return {
    region,
    endpoint: `${endpoint.protocol}//${endpoint.host}`,
    bucket,
    // Sem barra final: quem monta URL pública concatena `/${key}`, e duas
    // barras no meio do caminho viram uma chave diferente no S3.
    cdnUrl: cdnBruto.replace(/\/+$/, ''),
    key: obrigatoria(config, 'SPACES_KEY'),
    secret: obrigatoria(config, 'SPACES_SECRET'),
  };
}
