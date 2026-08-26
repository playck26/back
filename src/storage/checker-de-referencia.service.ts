import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { COLUNAS_DE_MIDIA } from './colunas-de-midia';
import {
  KeyReferenceRegistry,
  type KeyReferenceChecker,
} from './key-reference-checker';

/**
 * SPEC-018/TASK-007 — a implementação do `KeyReferenceChecker`, e o registro
 * dela.
 *
 * **A porta é da SPEC-017; a resposta é daqui** (REQ-007). A fundação
 * precisava perguntar "alguma linha ainda aponta para esta chave?" sem
 * conhecer nome de tabela nenhum — quem conhece as colunas de mídia é esta
 * spec.
 *
 * ## O que muda no worker quando isto entra
 *
 * Tudo. Até aqui o registro respondia `true` a qualquer pergunta (INV-044,
 * fail-closed): **sem checker, nada é apagado**. Era o certo — fundação no ar
 * antes do consumidor não pode apagar por não saber quem aponta. Com o
 * registro feito, o worker passa a apagar de fato o que não é mais
 * referenciado (AC-016).
 *
 * Isso significa que **este arquivo é o que liga a exclusão real**. Um bug
 * aqui não deixa lixo: apaga arquivo em uso.
 *
 * ## Por que a resposta é "qualquer uma", e por que ela para no primeiro sim
 *
 * AC-015: referenciada se **qualquer** das colunas apontar; não-referenciada
 * só quando nenhuma aponta. As consultas rodam em série e param no primeiro
 * `true` — não por performance, mas porque a resposta já está decidida, e
 * consultar as outras três só criaria oportunidade de uma delas falhar e
 * transformar um "sim" claro num erro.
 *
 * ## E se uma consulta falhar
 *
 * Responde **`true`** (referenciada). É o mesmo fail-closed do registro sem
 * checker, e pela mesma razão: banco indisponível tem de significar "não
 * sei", nunca "pode apagar". O erro vai para o log — o worker tentará de
 * novo no próximo ciclo, e um objeto que fica um ciclo a mais no bucket
 * custa centavos; um objeto apagado em uso custa a imagem de alguém.
 */
@Injectable()
export class CheckerDeReferencia implements KeyReferenceChecker, OnModuleInit {
  private readonly logger = new Logger(CheckerDeReferencia.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: KeyReferenceRegistry,
  ) {}

  /**
   * **O registro acontece no boot, e é a única chamada de `registrar()` no
   * produto.** Fora de `onModuleInit` seria preciso alguém lembrar de chamar,
   * e "alguém lembrar" é exatamente o que a INV-045 não aceita.
   */
  onModuleInit(): void {
    this.registry.registrar(this);
  }

  async estaReferenciada(key: string): Promise<boolean> {
    for (const coluna of COLUNAS_DE_MIDIA) {
      let aponta: boolean;
      try {
        aponta = await coluna.aponta(this.prisma, key);
      } catch (erro) {
        // Fail-closed. A chave NÃO vai para o log: ela carrega company_id e
        // o id do recurso, e este log pode acabar num agregador.
        this.logger.error({
          evento: 'checker_de_referencia_falhou',
          modelo: coluna.modelo,
          campo: coluna.campo,
          erro: erro instanceof Error ? erro.message : 'desconhecido',
        });
        return true;
      }

      if (aponta) {
        return true;
      }
    }

    return false;
  }
}
