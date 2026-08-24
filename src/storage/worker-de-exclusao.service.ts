import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { tentarLockDeChave } from './advisory-lock';
import { ALERTAS, AlertaDeStorage } from './alerta-de-storage';
import { KeyReferenceRegistry } from './key-reference-checker';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from './storage-provider.interface';

/** AC-016b — item recém-enfileirado só é apagado depois de 1 hora na fila. */
export const CARENCIA_MINUTOS = 60;

/** AC-016 — item com 5 tentativas falhas é sinalizado, não some em silêncio. */
export const MAXIMO_DE_TENTATIVAS = 5;

/** AC-016c — teto por ciclo e por empresa. */
export const TETO_POR_CICLO = 50;
export const TETO_POR_EMPRESA = 20;

/** AC-016d — chave quente: sinaliza acima disto. */
export const MAXIMO_DE_PULOS_POR_LOCK = 20;
export const HORAS_EM_FILA_ANTES_DE_SINALIZAR = 24;

export interface ResultadoDoCiclo {
  readonly elegiveis: number;
  readonly apagados: number;
  readonly descartados: number;
  readonly reagendados: number;
  readonly falhas: number;
  readonly pausado: boolean;
}

interface ItemDaFila {
  id: string;
  key: string;
  company_id: string;
  tentativas: number;
  lock_skip_count: number;
  criado_em: Date;
}

/**
 * SPEC-017/TASK-005 — o worker da fila de exclusão.
 *
 * **Ele é o único mecanismo do produto que apaga arquivo sozinho**, e é por
 * isso que quase tudo aqui é guarda em vez de trabalho. Cada uma protege de
 * um estado diferente, e a tabela dos três estados possíveis do checker
 * (spec, seção 4) resume por quê:
 *
 * | Checker | O que acontece sem defesa | Defesa |
 * |---|---|---|
 * | **ausente** | apagaria sem saber quem aponta | fail-closed (INV-044) |
 * | **presente e correto** | funciona | — |
 * | **presente e ERRADO** | **apaga o bucket inteiro achando que acertou** | carência + teto |
 *
 * O terceiro é pior que o primeiro e não tinha defesa nenhuma até a 6ª
 * rodada: o fail-closed protege contra **não saber**, e nada protegia contra
 * **saber errado**.
 *
 * **INV-042 — este worker NUNCA toma lock de linha.** Só advisory, e leituras
 * sem `FOR UPDATE`. É a regra que mais protege: o worker é assíncrono e roda
 * sozinho, então é o candidato natural a segurar uma linha e ficar esperando
 * outra coisa. Proibi-lo de tomar lock de linha o mantém de um lado só do
 * grafo, e não há ciclo possível.
 */
@Injectable()
export class WorkerDeExclusao {
  private readonly logger = new Logger(WorkerDeExclusao.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: KeyReferenceRegistry,
    private readonly alerta: AlertaDeStorage,
    @Inject(STORAGE_PROVIDER) private readonly provider: StorageProvider,
  ) {}

  async executarCiclo(): Promise<ResultadoDoCiclo> {
    const vazio: ResultadoDoCiclo = {
      elegiveis: 0,
      apagados: 0,
      descartados: 0,
      reagendados: 0,
      falhas: 0,
      pausado: false,
    };

    const elegiveis = await this.lerElegiveis();

    // ---- Guarda 1: o checker (AC-014b/014c, INV-044) --------------------
    if (!this.registry.temChecker()) {
      // O alerta é CONDICIONAL: ausência com fila vazia é o estado esperado
      // no vão entre a 017 e a 018, e não faz barulho. Fail-closed sem
      // alerta condicional troca "apaga o que não devia" por "nunca apaga e
      // ninguém percebe" — e o segundo demora muito mais para aparecer.
      if (elegiveis.length > 0) {
        this.alerta.disparar(ALERTAS.SEM_CHECKER_COM_FILA, {
          itens: elegiveis.length,
        });
      } else if (this.registry.jaTeveChecker()) {
        this.alerta.disparar(ALERTAS.CHECKER_SUMIU, {});
      }
      return { ...vazio, elegiveis: elegiveis.length };
    }
    if (!this.registry.jaTeveChecker()) {
      // Impossível hoje (`temChecker` implica `jaTeve`), mas a assimetria
      // entre os dois é o que a AC-014c exige, e deixá-la explícita evita
      // que um refactor futuro colapse os dois num só.
      this.alerta.disparar(ALERTAS.CHECKER_SUMIU, {});
    }

    // ---- Guarda 2: o teto (AC-016c, INV-047) ----------------------------
    const estouro = this.medirEstouro(elegiveis);
    if (estouro !== null) {
      // **Pausa é não processar NADA nesta rodada**, e não "processar 50 e
      // continuar depois". E a pausa não precisa de estado guardado: a
      // condição é a própria fila, então ela se repete a cada ciclo enquanto
      // a anomalia durar — inclusive depois de um restart, que é justamente
      // quando um flag em memória evaporaria.
      this.alerta.disparar(ALERTAS.TETO_ESTOURADO, estouro);
      return { ...vazio, elegiveis: elegiveis.length, pausado: true };
    }

    // ---- Trabalho -------------------------------------------------------
    let apagados = 0;
    let descartados = 0;
    let reagendados = 0;
    let falhas = 0;

    for (const item of elegiveis) {
      const resultado = await this.processar(item);
      if (resultado === 'apagado') apagados++;
      else if (resultado === 'descartado') descartados++;
      else if (resultado === 'reagendado') reagendados++;
      else falhas++;
    }

    return {
      elegiveis: elegiveis.length,
      apagados,
      descartados,
      reagendados,
      falhas,
      pausado: false,
    };
  }

  /**
   * Lê os elegíveis. **Sem `FOR UPDATE`** (INV-042), e o teto de leitura é
   * maior que o do ciclo de propósito: para detectar o estouro é preciso ver
   * mais itens do que se pode apagar.
   */
  private lerElegiveis(): Promise<ItemDaFila[]> {
    return this.prisma.$queryRaw<ItemDaFila[]>`
      SELECT id, key, company_id, tentativas, lock_skip_count, criado_em
      FROM arquivos_pendentes_exclusao
      WHERE criado_em <= now() - (${CARENCIA_MINUTOS} || ' minutes')::interval
        AND tentativas < ${MAXIMO_DE_TENTATIVAS}
      ORDER BY criado_em ASC
      LIMIT ${(TETO_POR_CICLO + 1) * 4}
    `;
  }

  private medirEstouro(
    itens: readonly ItemDaFila[],
  ): { itens: number; empresa?: string; naEmpresa?: number } | null {
    if (itens.length > TETO_POR_CICLO) {
      return { itens: itens.length };
    }
    const porEmpresa = new Map<string, number>();
    for (const item of itens) {
      porEmpresa.set(
        item.company_id,
        (porEmpresa.get(item.company_id) ?? 0) + 1,
      );
    }
    for (const [empresa, quantidade] of porEmpresa) {
      if (quantidade > TETO_POR_EMPRESA) {
        return { itens: itens.length, empresa, naEmpresa: quantidade };
      }
    }
    return null;
  }

  /**
   * Processa um item, inteiro dentro de uma transação — e é a transação que
   * segura o advisory lock (AC-015).
   *
   * **A chamada de rede ao Spaces acontece com a transação aberta**, o que
   * normalmente é cheiro ruim. Aqui é o ponto: o lock precisa valer do
   * `try` até depois do `DELETE`, senão existe a janela em que um `PUT` da
   * mesma chave grava e o worker apaga logo atrás — o cenário que a 3ª
   * rodada usou para derrubar a minha aposta de que o lock era desnecessário.
   */
  private async processar(
    item: ItemDaFila,
  ): Promise<'apagado' | 'descartado' | 'reagendado' | 'falhou'> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (!(await tentarLockDeChave(tx, item.key))) {
          await this.reagendarPorLock(tx, item);
          return 'reagendado';
        }

        // AC-014 — a reconferência acontece DEPOIS do lock. Antes dele, a
        // resposta poderia envelhecer entre a pergunta e o `DELETE`, que é
        // exatamente o defeito que o lock existe para fechar.
        if (await this.registry.estaReferenciada(item.key)) {
          await tx.$executeRaw`
            DELETE FROM arquivos_pendentes_exclusao WHERE id = ${item.id}::uuid
          `;
          return 'descartado';
        }

        await this.provider.apagar(item.key);
        // INV-036 — a ordem importa: apaga o objeto, depois a linha. Se a
        // linha sobreviver a uma falha aqui, o próximo ciclo tenta de novo e
        // `apagar` é idempotente. O inverso deixaria o objeto no bucket sem
        // ninguém para lembrar dele.
        await tx.$executeRaw`
          DELETE FROM arquivos_pendentes_exclusao WHERE id = ${item.id}::uuid
        `;
        return 'apagado';
      });
    } catch (causa) {
      await this.registrarFalha(item, causa);
      return 'falhou';
    }
  }

  /**
   * AC-015b/AC-016d — conflito de lock **não** é erro: contador próprio,
   * sem `ultimo_erro` e sem somar tentativa. Concorrência normal não é erro;
   * concorrência eterna é estado degradado, e é por isso que o contador
   * existe em vez de simplesmente não contar.
   */
  private async reagendarPorLock(
    tx: { $executeRaw: PrismaService['$executeRaw'] },
    item: ItemDaFila,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE arquivos_pendentes_exclusao
      SET lock_skip_count = lock_skip_count + 1, last_lock_conflict_at = now()
      WHERE id = ${item.id}::uuid
    `;

    const pulos = item.lock_skip_count + 1;
    const horasEmFila =
      (Date.now() - item.criado_em.getTime()) / (1000 * 60 * 60);
    if (
      pulos > MAXIMO_DE_PULOS_POR_LOCK ||
      horasEmFila > HORAS_EM_FILA_ANTES_DE_SINALIZAR
    ) {
      this.alerta.disparar(ALERTAS.CHAVE_PRESA_EM_LOCK, {
        pulos,
        horasEmFila: Math.round(horasEmFila),
      });
    }
  }

  /**
   * Falha de verdade: soma tentativa e grava o erro. Fora da transação que
   * falhou, porque aquela já foi ao chão — e um `UPDATE` numa transação
   * abortada não grava nada, que é como um item falharia cinco vezes sem
   * nunca chegar a cinco.
   */
  private async registrarFalha(
    item: ItemDaFila,
    causa: unknown,
  ): Promise<void> {
    const mensagem = causa instanceof Error ? causa.message : String(causa);
    try {
      await this.prisma.$executeRaw`
        UPDATE arquivos_pendentes_exclusao
        SET tentativas = tentativas + 1, ultimo_erro = ${mensagem.slice(0, 500)}
        WHERE id = ${item.id}::uuid
      `;
    } catch (erroAoRegistrar) {
      this.logger.error({
        evento: 'falha_ao_registrar_falha',
        detalhe: String(erroAoRegistrar),
      });
    }

    if (item.tentativas + 1 >= MAXIMO_DE_TENTATIVAS) {
      this.alerta.disparar(ALERTAS.EXCLUSAO_FALHANDO, {
        tentativas: item.tentativas + 1,
        erro: mensagem.slice(0, 200),
      });
    }
  }
}
