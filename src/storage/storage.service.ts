import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  conferirChave,
  type EsperadoDaChave,
  type TipoDeMidia,
  visibilidadeDe,
} from './chave-de-midia';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from './storage-provider.interface';

/**
 * SPEC-017/TASK-003 — o ponto que impõe a INV-037.
 *
 * A invariante não diz "existe um parser". Diz **"o `StorageService` nunca
 * assina chave crua"** — e um parser que o chamador pode esquecer de chamar
 * não impõe nada. Por isso a assinatura não é acessível daqui de fora sem
 * passar pela conferência: o caminho seguro é o único caminho.
 *
 * **A recusa é 404, nunca 403** (REQ-006): 403 confirmaria que o objeto
 * existe, e a pergunta que estamos protegendo é justamente "existe uma foto
 * neste id?".
 *
 * **E não há parâmetro de expiração.** O regime sai do tipo de mídia, e o
 * prazo é o teto da AC-010. Foi ressalva da validação cruzada de 2026-08-24:
 * expiração escolhida pelo chamador é política de segurança decidida no
 * ponto de uso, que é onde ela sempre acaba errada.
 */
export const OBJETO_NAO_ENCONTRADO = {
  statusCode: 404,
  code: 'OBJETO_NAO_ENCONTRADO',
  message: 'Objeto não encontrado.',
} as const;

export interface PedidoDeLeitura extends EsperadoDaChave {
  /** A chave como está no banco — tratada como não confiável. */
  readonly key: unknown;
}

@Injectable()
export class StorageService {
  constructor(
    @Inject(STORAGE_PROVIDER) private readonly provider: StorageProvider,
  ) {}

  /**
   * Devolve a URL de leitura no regime do tipo: CDN para pública, assinada
   * para privada. Recusa com 404 qualquer chave que não bata com o recurso.
   */
  async urlDeLeitura(pedido: PedidoDeLeitura): Promise<string> {
    const chave = this.conferir(pedido);
    if (chave.visibilidade === 'publico') {
      return this.provider.urlPublica(chave.key);
    }
    // Sem argumento de expiração: o adaptador aplica o teto da AC-010.
    return this.provider.urlAssinada(chave.key);
  }

  /**
   * A visibilidade de um tipo, para quem precisa decidir antes de ter chave
   * (a SPEC-018 decide o ACL do upload por aqui). Exposta como função do
   * **tipo**, nunca como parâmetro que o chamador escolhe.
   */
  visibilidadeDoTipo(tipo: TipoDeMidia) {
    return visibilidadeDe(tipo);
  }

  private conferir(pedido: PedidoDeLeitura) {
    const resultado = conferirChave(pedido.key, pedido);
    if (!resultado.valida) {
      // O motivo NÃO vai para a resposta: ele distingue "não existe" de
      // "existe e não é sua", que é exatamente o que o 404 esconde. E não
      // vai para log com dado pessoal junto — a chave não tem nome nem
      // e-mail, mas o motivo também não precisa do id do recurso.
      throw new NotFoundException(OBJETO_NAO_ENCONTRADO);
    }
    return resultado.chave;
  }
}
