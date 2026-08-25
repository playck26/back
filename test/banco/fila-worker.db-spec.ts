/**
 * SPEC-017/TASK-005 — o worker de exclusão, contra Postgres de verdade.
 *
 * **Esta suíte existe porque mock não tem advisory lock.** O worker inteiro é
 * uma sequência de decisões sobre concorrência e tempo: quem consegue o lock,
 * o que acontece com quem não consegue, o que vale como "1 hora em fila". Um
 * teste com Prisma mockado provaria que o código chama as funções certas —
 * não que elas fazem o que ele acha.
 *
 * A lição da SPEC-015 vale aqui inteira: **três correções seguidas de lock
 * estavam erradas, e cada uma passava no teste da anterior.**
 */
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { exigirBancoLocal } from './exigir-banco-local';
import {
  comLockDeChaves,
  tentarLockDeChave,
} from '../../src/storage/advisory-lock';
import {
  ALERTAS,
  AlertaDeStorage,
  type CodigoDeAlerta,
  type DetalheDoAlerta,
} from '../../src/storage/alerta-de-storage';
import { KeyReferenceRegistry } from '../../src/storage/key-reference-checker';
import type { StorageProvider } from '../../src/storage/storage-provider.interface';
import {
  TETO_POR_CICLO,
  TETO_POR_EMPRESA,
  WorkerDeExclusao,
} from '../../src/storage/worker-de-exclusao.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(120_000);

// Antes de qualquer conexão: esta suíte escreve, e o `.env` real aponta para
// o Neon de produção (achado da validação cruzada).
exigirBancoLocal();

const A = new PrismaClient(); // o worker
const B = new PrismaClient(); // quem disputa o lock

const EMPRESA = 'a1b2c3d4-11ef-4111-8111-1f1e1d1c1b1a';
const EMPRESA_2 = 'b2c3d4e5-22ef-4222-8222-2f2e2d2c2b2a';
const RECURSO = 'c3d4e5f6-33ef-4333-8333-3f3e3d3c3b3a';

/**
 * `padEnd` colidia — `'e1'` e `'e10'` viravam a mesma string, e o UNIQUE da
 * tabela reprovou na cara. sha256 do rótulo dá 64 hex minúsculos por
 * construção, que é exatamente o que a gramática da chave exige.
 */
function chave(rotulo: string, empresa = EMPRESA): string {
  const sha = createHash('sha256').update(rotulo).digest('hex');
  return `empresas/${empresa}/quadra/${RECURSO}/${sha}.webp`;
}

/** Enfileira direto no banco, com a idade que o teste precisar. */
async function enfileirar(
  key: string,
  opcoes: { minutosAtras?: number; tentativas?: number } = {},
): Promise<void> {
  const { minutosAtras = 120, tentativas = 0 } = opcoes;
  const empresa = key.split('/')[1];
  await A.$executeRawUnsafe(
    `INSERT INTO arquivos_pendentes_exclusao
       (id, key, company_id, motivo, tentativas, ultimo_erro, criado_em)
     VALUES (gen_random_uuid(), $1, $2::uuid, 'teste', $3, $4,
             now() - ($5 || ' minutes')::interval)`,
    key,
    empresa,
    tentativas,
    tentativas > 0 ? 'erro anterior' : null,
    String(minutosAtras),
  );
}

async function linhaDe(key: string) {
  const linhas = await A.$queryRawUnsafe<
    {
      tentativas: number;
      lock_skip_count: number;
      ultimo_erro: string | null;
    }[]
  >(
    `SELECT tentativas, lock_skip_count, ultimo_erro
     FROM arquivos_pendentes_exclusao WHERE key = $1`,
    key,
  );
  return linhas[0] ?? null;
}

class AlertaEspiao extends AlertaDeStorage {
  readonly disparados: { codigo: CodigoDeAlerta; detalhe?: DetalheDoAlerta }[] =
    [];
  disparar(codigo: CodigoDeAlerta, detalhe?: DetalheDoAlerta): void {
    this.disparados.push({ codigo, detalhe });
  }
  codigos(): CodigoDeAlerta[] {
    return this.disparados.map((d) => d.codigo);
  }
}

describe('WorkerDeExclusao contra Postgres real', () => {
  let registry: KeyReferenceRegistry;
  let alerta: AlertaEspiao;
  let apagados: string[];
  let provider: StorageProvider;
  let worker: WorkerDeExclusao;

  beforeEach(async () => {
    await A.$executeRawUnsafe('DELETE FROM arquivos_pendentes_exclusao');
    registry = new KeyReferenceRegistry();
    alerta = new AlertaEspiao();
    apagados = [];
    provider = {
      gravar: () => Promise.resolve(),
      apagar: (key) => {
        apagados.push(key);
        return Promise.resolve();
      },
      metadados: () => Promise.resolve(null),
      urlPublica: (k) => k,
      urlAssinada: (k) => Promise.resolve(k),
      medirUso: () => Promise.resolve({ objetos: 0, bytes: 0, completo: true }),
    };
    worker = new WorkerDeExclusao(
      A as unknown as PrismaService,
      registry,
      alerta,
      provider,
    );
  });

  afterAll(async () => {
    await A.$executeRawUnsafe('DELETE FROM arquivos_pendentes_exclusao');
    await A.$disconnect();
    await B.$disconnect();
  });

  describe('INV-044 — fail-closed sem checker', () => {
    it('NÃO apaga nada quando não há checker registrado', async () => {
      await enfileirar(chave('a'));

      const r = await worker.executarCiclo();

      expect(apagados).toEqual([]);
      expect(r.apagados).toBe(0);
      expect(await linhaDe(chave('a'))).not.toBeNull();
    });

    it('e ALERTA, porque a fila não está vazia (AC-014c)', async () => {
      await enfileirar(chave('a'));
      await worker.executarCiclo();
      expect(alerta.codigos()).toEqual([ALERTAS.SEM_CHECKER_COM_FILA]);
    });

    it('mas fica QUIETO com a fila vazia — é o estado esperado no vão', async () => {
      // Fail-closed sem alerta condicional troca "apaga o que não devia" por
      // "nunca apaga e ninguém percebe". Mas alerta sem condição vira ruído
      // durante semanas, e alerta que vira ruído deixa de ser alerta.
      await worker.executarCiclo();
      expect(alerta.disparados).toEqual([]);
    });

    it('alerta CHECKER_SUMIU quando existiu e sumiu, mesmo com fila vazia', async () => {
      registry.registrar({ estaReferenciada: () => Promise.resolve(false) });
      registry.desregistrar();
      await worker.executarCiclo();
      expect(alerta.codigos()).toEqual([ALERTAS.CHECKER_SUMIU]);
    });
  });

  describe('AC-014 — a reconferência manda', () => {
    it('checker dizendo "referenciada": descarta a linha SEM apagar', async () => {
      await enfileirar(chave('a'));
      registry.registrar({ estaReferenciada: () => Promise.resolve(true) });

      const r = await worker.executarCiclo();

      expect(apagados).toEqual([]);
      expect(r.descartados).toBe(1);
      // A linha some: a chave voltou a ser usada, e mantê-la na fila só
      // faria o worker perguntar de novo para sempre.
      expect(await linhaDe(chave('a'))).toBeNull();
    });

    it('checker dizendo "não referenciada": apaga o objeto e a linha', async () => {
      await enfileirar(chave('a'));
      registry.registrar({ estaReferenciada: () => Promise.resolve(false) });

      const r = await worker.executarCiclo();

      expect(apagados).toEqual([chave('a')]);
      expect(r.apagados).toBe(1);
      expect(await linhaDe(chave('a'))).toBeNull();
    });

    it('pergunta pela chave exata que está na fila', async () => {
      const perguntadas: string[] = [];
      await enfileirar(chave('a'));
      registry.registrar({
        estaReferenciada: (k) => {
          perguntadas.push(k);
          return Promise.resolve(true);
        },
      });
      await worker.executarCiclo();
      expect(perguntadas).toEqual([chave('a')]);
    });
  });

  describe('AC-016b — a carência de 1 hora', () => {
    beforeEach(() => {
      registry.registrar({ estaReferenciada: () => Promise.resolve(false) });
    });

    it('item de 5 minutos NÃO é apagado', async () => {
      // Exclusão errada deixa de ser instantânea e ganha uma janela em que
      // alguém pode perceber.
      await enfileirar(chave('a'), { minutosAtras: 5 });
      const r = await worker.executarCiclo();
      expect(r.elegiveis).toBe(0);
      expect(apagados).toEqual([]);
    });

    it('item de 59 minutos ainda não; de 61, sim', async () => {
      await enfileirar(chave('a'), { minutosAtras: 59 });
      expect((await worker.executarCiclo()).elegiveis).toBe(0);

      await A.$executeRawUnsafe('DELETE FROM arquivos_pendentes_exclusao');
      await enfileirar(chave('b'), { minutosAtras: 61 });
      expect((await worker.executarCiclo()).apagados).toBe(1);
    });
  });

  describe('AC-016c/INV-047 — o teto pausa o ciclo inteiro', () => {
    beforeEach(() => {
      registry.registrar({ estaReferenciada: () => Promise.resolve(false) });
    });

    it('checker com BUG dizendo "não referenciada" para tudo: o bucket NÃO é esvaziado', async () => {
      // O terceiro estado do checker, e o pior: o fail-closed protege contra
      // NÃO SABER, e nada protegia contra SABER ERRADO.
      for (let i = 0; i < TETO_POR_CICLO + 5; i++) {
        await enfileirar(chave(`c${i}`, i % 2 === 0 ? EMPRESA : EMPRESA_2));
      }

      const r = await worker.executarCiclo();

      expect(r.pausado).toBe(true);
      expect(apagados).toEqual([]);
      expect(alerta.codigos()).toContain(ALERTAS.TETO_ESTOURADO);
    });

    it('pausa também por empresa, mesmo com o total dentro do teto', async () => {
      for (let i = 0; i < TETO_POR_EMPRESA + 1; i++) {
        await enfileirar(chave(`e${i}`));
      }
      expect(TETO_POR_EMPRESA + 1).toBeLessThan(TETO_POR_CICLO);

      const r = await worker.executarCiclo();

      expect(r.pausado).toBe(true);
      expect(apagados).toEqual([]);
      expect(alerta.disparados[0].detalhe).toMatchObject({ empresa: EMPRESA });
    });

    it('a pausa se REPETE no ciclo seguinte, sem depender de estado guardado', async () => {
      // A condição é a própria fila, então a pausa sobrevive a um restart —
      // que é justamente quando um flag em memória evaporaria.
      for (let i = 0; i < TETO_POR_EMPRESA + 1; i++) {
        await enfileirar(chave(`e${i}`));
      }
      const outroWorker = new WorkerDeExclusao(
        A as unknown as PrismaService,
        registry,
        alerta,
        provider,
      );
      expect((await outroWorker.executarCiclo()).pausado).toBe(true);
      expect(apagados).toEqual([]);
    });

    it('exatamente no teto por empresa NÃO pausa', async () => {
      for (let i = 0; i < TETO_POR_EMPRESA; i++) {
        await enfileirar(chave(`e${i}`));
      }
      const r = await worker.executarCiclo();
      expect(r.pausado).toBe(false);
      expect(r.apagados).toBe(TETO_POR_EMPRESA);
    });
  });

  describe('INV-039/AC-015 — o advisory lock por chave', () => {
    beforeEach(() => {
      registry.registrar({ estaReferenciada: () => Promise.resolve(false) });
    });

    it('NÃO apaga enquanto outra transação segura o lock da mesma chave', async () => {
      // É a prova do cenário que derrubou a minha aposta de que o lock era
      // desnecessário: alguém sobe o conteúdo e o banco passa a referenciar a
      // chave; o worker, que já tinha reconferido antes, executa o DELETE; e
      // o banco aponta para objeto ausente. "O próximo upload conserta" só
      // vale se alguém repetir o upload, e ninguém repete o que não sabe que
      // quebrou.
      const key = chave('a');
      await enfileirar(key);

      let liberar!: () => void;
      const podeSoltar = new Promise<void>((r) => (liberar = r));

      const segurando = B.$transaction(async (tx) => {
        const tomou = await tentarLockDeChave(tx, key);
        expect(tomou).toBe(true);
        await podeSoltar;
      });

      // Espera o lock estar de pé antes de rodar o worker.
      await new Promise((r) => setTimeout(r, 200));
      const r = await worker.executarCiclo();

      expect(apagados).toEqual([]);
      expect(r.reagendados).toBe(1);
      expect(r.apagados).toBe(0);

      liberar();
      await segurando;
    });

    it('AC-015b: conflito de lock NÃO conta como erro', async () => {
      // Concorrência normal não é erro. Se contasse em `tentativas`, uma
      // chave disputada chegaria a 5 falhas e seria sinalizada como problema
      // sendo o sistema funcionando.
      const key = chave('a');
      await enfileirar(key);

      let liberar!: () => void;
      const podeSoltar = new Promise<void>((r) => (liberar = r));
      const segurando = B.$transaction(async (tx) => {
        await tentarLockDeChave(tx, key);
        await podeSoltar;
      });
      await new Promise((r) => setTimeout(r, 200));

      await worker.executarCiclo();

      const linha = await linhaDe(key);
      expect(linha).toMatchObject({
        tentativas: 0,
        lock_skip_count: 1,
        ultimo_erro: null,
      });

      liberar();
      await segurando;
    });

    it('solto o lock, o ciclo seguinte apaga', async () => {
      const key = chave('a');
      await enfileirar(key);

      let liberar!: () => void;
      const podeSoltar = new Promise<void>((r) => (liberar = r));
      const segurando = B.$transaction(async (tx) => {
        await tentarLockDeChave(tx, key);
        await podeSoltar;
      });
      await new Promise((r) => setTimeout(r, 200));
      await worker.executarCiclo();
      liberar();
      await segurando;

      const r = await worker.executarCiclo();
      expect(r.apagados).toBe(1);
      expect(apagados).toEqual([key]);
    });

    it('o lock é POR CHAVE: outra chave não é bloqueada', async () => {
      await enfileirar(chave('a'));
      await enfileirar(chave('b'));

      let liberar!: () => void;
      const podeSoltar = new Promise<void>((r) => (liberar = r));
      const segurando = B.$transaction(async (tx) => {
        await tentarLockDeChave(tx, chave('a'));
        await podeSoltar;
      });
      await new Promise((r) => setTimeout(r, 200));

      const r = await worker.executarCiclo();

      expect(apagados).toEqual([chave('b')]);
      expect(r.reagendados).toBe(1);

      liberar();
      await segurando;
    });

    it('INV-046: o worker NUNCA espera — o ciclo devolve rápido', async () => {
      const key = chave('a');
      await enfileirar(key);
      let liberar!: () => void;
      const podeSoltar = new Promise<void>((r) => (liberar = r));
      const segurando = B.$transaction(async (tx) => {
        await tentarLockDeChave(tx, key);
        await podeSoltar;
      });
      await new Promise((r) => setTimeout(r, 200));

      const inicio = Date.now();
      await worker.executarCiclo();
      const duracao = Date.now() - inicio;

      // Com `pg_advisory_lock` (bloqueante) isto ficaria preso até o
      // `liberar()`, que só acontece depois. 3 segundos é folga larga para
      // uma operação que não espera por nada.
      expect(duracao).toBeLessThan(3000);

      liberar();
      await segurando;
    });

    it('o lock SOLTA sozinho no rollback — a razão do `xact`', async () => {
      // Lock de sessão numa conexão de pool, com um caminho de exceção que
      // pule o unlock, envenena aquela conexão para sempre.
      const key = chave('a');
      await B.$transaction(async (tx) => {
        expect(await tentarLockDeChave(tx, key)).toBe(true);
        throw new Error('rollback proposital');
      }).catch(() => undefined);

      await A.$transaction(async (tx) => {
        expect(await tentarLockDeChave(tx, key)).toBe(true);
      });
    });
  });

  describe('comLockDeChaves — o lado da ESCRITA (AC-021/INV-042)', () => {
    it('não roda a ação se alguma das chaves estiver tomada', async () => {
      const key = chave('a');
      let liberar!: () => void;
      const podeSoltar = new Promise<void>((r) => (liberar = r));
      const segurando = B.$transaction(async (tx) => {
        await tentarLockDeChave(tx, key);
        await podeSoltar;
      });
      await new Promise((r) => setTimeout(r, 200));

      let rodou = false;
      const resultado = await A.$transaction((tx) =>
        comLockDeChaves(tx, [chave('z'), key], () => {
          rodou = true;
          return Promise.resolve('feito');
        }),
      );

      // Desistir inteiro, e não rodar "a parte que deu": meia escrita com
      // metade dos locks é pior que escrita nenhuma.
      expect(resultado).toBeNull();
      expect(rodou).toBe(false);

      liberar();
      await segurando;
    });

    it('roda a ação quando consegue todas', async () => {
      const resultado = await A.$transaction((tx) =>
        comLockDeChaves(tx, [chave('a'), chave('b')], () =>
          Promise.resolve('feito'),
        ),
      );
      expect(resultado).toBe('feito');
    });

    it('segura TODOS os locks pedidos ao mesmo tempo, dentro da ação', async () => {
      // A ordem de aquisição é provada no unitário (`advisory-lock.spec.ts`),
      // onde dá para observar cada chamada. O que só o banco prova é que os
      // dois locks estão de pé SIMULTANEAMENTE quando a ação roda — um lock
      // que soltou antes da escrita não protege nada.
      await A.$transaction(async (tx) => {
        await comLockDeChaves(tx, [chave('zzz'), chave('aaa')], async () => {
          const locks = await tx.$queryRaw<{ objid: number }[]>`
            SELECT objid FROM pg_locks
            WHERE locktype = 'advisory' AND pid = pg_backend_pid()
          `;
          expect(locks).toHaveLength(2);
          return null;
        });
      });
    });
  });

  describe('duas réplicas — o que o teto garante e o que não garante', () => {
    // A 2ª validação cruzada levantou que `TETO_POR_CICLO` seria "por
    // processo", virando 100 com duas instâncias. Estes testes medem.
    function outroWorker(cliente: PrismaClient) {
      return new WorkerDeExclusao(
        cliente as unknown as PrismaService,
        registry,
        alerta,
        provider,
      );
    }

    beforeEach(() => {
      registry.registrar({ estaReferenciada: () => Promise.resolve(false) });
    });

    it('o teto é avaliado sobre a FILA, que é compartilhada: as duas pausam', async () => {
      for (let i = 0; i < TETO_POR_EMPRESA + 1; i++) {
        await enfileirar(chave(`r${i}`));
      }

      const [a, b] = await Promise.all([
        worker.executarCiclo(),
        outroWorker(B).executarCiclo(),
      ]);

      // O teto não multiplica por réplica porque não conta o que ESTE
      // processo fez — conta o que está na fila, e a fila é uma só.
      expect(a.pausado).toBe(true);
      expect(b.pausado).toBe(true);
      expect(apagados).toEqual([]);
    });

    it('linha que sumiu entre a leitura e o lock NÃO vira DeleteObject', async () => {
      // O teste abaixo passava por TIMING. Este força o interleaving exato:
      // enquanto o worker processa o primeiro item, a linha do segundo é
      // apagada por fora — como faria outra réplica que chegou primeiro.
      const primeiro = chave('x1');
      const segundo = chave('x2');
      await enfileirar(primeiro);
      await enfileirar(segundo);

      registry.desregistrar();
      registry.registrar({
        estaReferenciada: async (k) => {
          if (k === primeiro) {
            await A.$executeRawUnsafe(
              'DELETE FROM arquivos_pendentes_exclusao WHERE key = $1',
              segundo,
            );
          }
          return false;
        },
      });

      const r = await worker.executarCiclo();

      // O segundo não pode ter virado chamada de rede: a linha dele já não
      // existia quando o worker pegou o lock.
      expect(apagados).toEqual([primeiro]);
      expect(r.apagados).toBe(1);
      expect(r.descartados).toBe(1);
    });

    it('abaixo do teto, cada objeto é apagado UMA vez só', async () => {
      // O que a concorrência poderia duplicar é a CHAMADA ao Spaces: a
      // réplica B leu a fila antes de A commitar, e chegaria com o lock já
      // livre e a linha já apagada.
      const chaves = [chave('r1'), chave('r2'), chave('r3')];
      for (const k of chaves) {
        await enfileirar(k);
      }

      await Promise.all([
        worker.executarCiclo(),
        outroWorker(B).executarCiclo(),
      ]);

      expect([...apagados].sort()).toEqual([...chaves].sort());
      expect(apagados).toHaveLength(chaves.length);
    });
  });

  describe('AC-012/016 — falha de exclusão', () => {
    beforeEach(() => {
      registry.registrar({ estaReferenciada: () => Promise.resolve(false) });
    });

    it('grava ultimo_erro e soma tentativa quando o provider falha', async () => {
      const key = chave('a');
      await enfileirar(key);
      provider.apagar = () => Promise.reject(new Error('AccessDenied'));

      const r = await worker.executarCiclo();

      expect(r.falhas).toBe(1);
      const linha = await linhaDe(key);
      expect(linha).toMatchObject({ tentativas: 1, lock_skip_count: 0 });
      expect(linha?.ultimo_erro).toContain('AccessDenied');
    });

    it('na 5ª falha sinaliza, e o item sai dos elegíveis', async () => {
      const key = chave('a');
      await enfileirar(key, { tentativas: 4 });
      provider.apagar = () => Promise.reject(new Error('AccessDenied'));

      await worker.executarCiclo();
      expect(alerta.codigos()).toContain(ALERTAS.EXCLUSAO_FALHANDO);

      // Não some em silêncio: a linha continua lá, fora do trabalho normal,
      // esperando alguém olhar.
      expect(await linhaDe(key)).toMatchObject({ tentativas: 5 });
      expect((await worker.executarCiclo()).elegiveis).toBe(0);
    });

    it('o alerta do item travado se REPETE nos ciclos seguintes', async () => {
      // Achado da 2ª validação cruzada: o alerta disparava uma vez, no ciclo
      // em que o item estourou — e some junto com o log daquele dia. A
      // AC-016 diz que ele não some em silêncio, então a condição virou a
      // própria fila, como na pausa do teto.
      await enfileirar(chave('a'), { tentativas: 5 });

      const primeiro = await worker.executarCiclo();
      expect(primeiro.elegiveis).toBe(0); // já saiu do trabalho normal
      expect(primeiro.travados).toBe(1);
      expect(alerta.codigos()).toEqual([ALERTAS.EXCLUSAO_FALHANDO]);

      // Worker novo: prova que o redisparo não depende de estado em memória,
      // e portanto sobrevive a restart.
      const depoisDoRestart = new WorkerDeExclusao(
        A as unknown as PrismaService,
        registry,
        alerta,
        provider,
      );
      await depoisDoRestart.executarCiclo();
      expect(alerta.codigos()).toEqual([
        ALERTAS.EXCLUSAO_FALHANDO,
        ALERTAS.EXCLUSAO_FALHANDO,
      ]);
    });

    it('sem item travado, nenhum alerta de exclusão falhando', async () => {
      await enfileirar(chave('a'));
      const r = await worker.executarCiclo();
      expect(r.travados).toBe(0);
      expect(alerta.codigos()).not.toContain(ALERTAS.EXCLUSAO_FALHANDO);
    });

    it('INV-036: falha ao apagar NÃO remove a linha da fila', async () => {
      const key = chave('a');
      await enfileirar(key);
      provider.apagar = () => Promise.reject(new Error('timeout'));
      await worker.executarCiclo();
      expect(await linhaDe(key)).not.toBeNull();
    });
  });

  describe('AC-016d — chave quente', () => {
    it('sinaliza depois de muitos pulos por lock, sem contar como erro', async () => {
      const key = chave('a');
      registry.registrar({ estaReferenciada: () => Promise.resolve(false) });
      await enfileirar(key);
      await A.$executeRawUnsafe(
        `UPDATE arquivos_pendentes_exclusao
         SET lock_skip_count = 20, last_lock_conflict_at = now() WHERE key = $1`,
        key,
      );

      let liberar!: () => void;
      const podeSoltar = new Promise<void>((r) => (liberar = r));
      const segurando = B.$transaction(async (tx) => {
        await tentarLockDeChave(tx, key);
        await podeSoltar;
      });
      await new Promise((r) => setTimeout(r, 200));

      await worker.executarCiclo();

      expect(alerta.codigos()).toContain(ALERTAS.CHAVE_PRESA_EM_LOCK);
      expect(await linhaDe(key)).toMatchObject({
        tentativas: 0,
        ultimo_erro: null,
      });

      liberar();
      await segurando;
    });
  });
});
