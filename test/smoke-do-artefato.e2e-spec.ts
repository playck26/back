import { execFileSync, spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * **SPEC-071/TASK-003 — o SMOKE do artefato construído.**
 *
 * ## Por que gate de texto no `dist/` não serve
 *
 * A primeira versão da AC exigia `nest build` verde mais um grep na chamada de
 * topo do `dist/main.js`, e justificava o resto dizendo que *"esta máquina não
 * sobe o app com banco"*. **A justificativa era falsa** — há um PostgreSQL 18
 * local de pé —, e a 8ª rodada de validação a derrubou com um comando.
 *
 * Para uma mudança cujo risco declarado é **"produção não sobe"**, texto é a
 * prova errada. Duas medições fecham a questão:
 *
 * - **`nest build` pode sair `0` sem emitir `dist/main.js`** (incremental).
 *   Exit code de build não é prova de artefato — por isso o passo 0 afirma a
 *   **existência** do arquivo, e não o código de saída;
 * - o `dist/main.js` compilado tem `void (0, bootstrap_1.bootstrap)()`, e
 *   **não** `bootstrap()`. Um grep pela forma do fonte ficaria **vermelho num
 *   build correto**.
 *
 * ## O contrato, e ele é determinístico de propósito
 *
 * *"Deadline explícito"* não fixa nada: `1 ms` e `24 h` satisfaziam igualmente
 * a redação anterior. Os oito passos abaixo são o contrato que a 8ª rodada
 * exigiu, e cada um existe por um modo de falha nomeado.
 *
 * ## O que ele NÃO prova
 *
 * Carga do processo e início de serviço — **não** topologia, latência, Neon nem
 * App Platform. E a corrida entre *"a porta está livre"* e o `spawn` não
 * desaparece; o que não pode é `EADDRINUSE` virar silêncio.
 */

const RAIZ = path.resolve(__dirname, '..');
const ARTEFATO = path.join(RAIZ, 'dist', 'main.js');

/** Porta acordada deste projeto para processo de teste. */
const PORTA = 3777;

/** Prazo **único e numérico**. Ver o cabeçalho: "explícito" não era contrato. */
const PRAZO_MS = 30_000;

/** Folga para o filho sair sozinho antes do `SIGKILL`. */
const PRAZO_DE_SAIDA_MS = 5_000;

const CONTROLE = { rota: '/api/v1/', status: 200, corpo: 'Hello World!' };

function urlDoBanco(base: string, nome: string): string {
  const url = new URL(base);
  url.pathname = `/${nome}`;
  return url.toString();
}

/**
 * O Prisma CLI pelo caminho resolvido, com `process.execPath`.
 *
 * `execFileSync('pnpm.cmd', …)` falha com `EINVAL` no Windows desde o conserto
 * de segurança do Node (CVE-2024-27980): `.cmd` só sobe com `shell: true`, e
 * afrouxar isso para rodar um comando é a mesma tentação que o `CLAUDE.md` já
 * registra sobre a `ExecutionPolicy`.
 */
function prisma(args: string[], url: string): void {
  const pkg = require.resolve('prisma/package.json');
  const manifesto = JSON.parse(fs.readFileSync(pkg, 'utf8')) as {
    bin: string | Record<string, string>;
  };
  const bin = path.join(
    path.dirname(pkg),
    typeof manifesto.bin === 'string' ? manifesto.bin : manifesto.bin.prisma,
  );
  execFileSync(process.execPath, [bin, ...args], {
    cwd: RAIZ,
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

/**
 * **Passo 2 — bind de verdade, e `EADDRINUSE` FALHA.**
 *
 * Não é "consultar se parece livre": é abrir e fechar. Porta ocupada derruba o
 * teste — *nunca* `skip`, que é como um gate vira sinal verde sobre nada.
 */
async function exigirPortaLivre(porta: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const servidor = net.createServer();
    servidor.once('error', (erro: NodeJS.ErrnoException) => {
      reject(
        new Error(
          `a porta ${porta} está ocupada (${erro.code}). ` +
            'O smoke FALHA em vez de pular: gate que pula é gate que mente.',
        ),
      );
    });
    servidor.once('listening', () => servidor.close(() => resolve()));
    servidor.listen(porta, '127.0.0.1');
  });
}

async function portaRespondeu(porta: number): Promise<void> {
  for (;;) {
    const aberta = await new Promise<boolean>((resolve) => {
      const s = net
        .connect({ port: porta, host: '127.0.0.1' })
        // `destroy`, e não `end`: `end` faz meio-fechamento e o socket fica
        // pendurado. Jest avisa "did not exit one second after…" e, no CI,
        // um runner que não sai come o job inteiro.
        .once('connect', () => {
          s.destroy();
          resolve(true);
        })
        .once('error', () => {
          s.destroy();
          resolve(false);
        });
    });
    if (aberta) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('o artefato construído sobe e começa a servir', () => {
  it('passo 0: `dist/main.js` EXISTE', () => {
    expect(fs.existsSync(ARTEFATO)).toBe(true);
  });

  it('sobe com banco descartável, responde o controle, e não deixa resto', async () => {
    const base = process.env.DATABASE_URL;
    // Sem banco, o smoke FALHA. Pular seria transformar a prova em decoração.
    expect(typeof base).toBe('string');

    const nome = `smoke_${process.pid}_${Date.now()}`;
    const urlAdmin = urlDoBanco(base as string, 'postgres');
    const urlNova = urlDoBanco(base as string, nome);

    let filho: ChildProcess | undefined;
    let bancoCriado = false;
    let primaria: unknown;
    let saida = '';

    try {
      // ---- 1. o banco descartável. O `try` começa AQUI, e não depois do
      // `spawn`: se a migração falhar, o banco criado ainda precisa sumir.
      const admin = new PrismaClient({ datasourceUrl: urlAdmin });
      await admin.$executeRawUnsafe(`CREATE DATABASE "${nome}"`);
      await admin.$disconnect();
      bancoCriado = true;
      prisma(['migrate', 'deploy'], urlNova);

      // ---- 2. a porta, por bind de verdade
      await exigirPortaLivre(PORTA);

      // ---- 3. o filho, NÃO destacado
      filho = spawn(process.execPath, [ARTEFATO], {
        cwd: RAIZ,
        env: { ...process.env, PORT: String(PORTA), DATABASE_URL: urlNova },
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      filho.stdout?.on('data', (c: Buffer) => (saida += c.toString()));
      filho.stderr?.on('data', (c: Buffer) => (saida += c.toString()));

      // ---- 4. a corrida: morte do filho falha IMEDIATAMENTE, sem esperar o
      // prazo. Sem isto, um processo que morre no arranque custa 30 s e
      // devolve "a porta não respondeu", que é o diagnóstico errado.
      const morreu = new Promise<never>((_, reject) => {
        filho?.once('exit', (code, signal) =>
          reject(
            new Error(
              `o processo MORREU antes de servir (code=${code} signal=${signal})\n${saida}`,
            ),
          ),
        );
      });

      // ---- 5. o prazo, único e numérico
      let bateu: NodeJS.Timeout | undefined;
      const prazo = new Promise<never>((_, reject) => {
        bateu = setTimeout(
          () =>
            reject(
              new Error(`a porta não respondeu em ${PRAZO_MS} ms\n${saida}`),
            ),
          PRAZO_MS,
        );
      });

      try {
        await Promise.race([portaRespondeu(PORTA), morreu, prazo]);
      } finally {
        if (bateu) clearTimeout(bateu);
      }

      // ---- 6. o controle EXATO. `404` ou `401` também provariam que está
      // servindo, mas há resposta melhor no baseline: esta rota devolve `200`
      // com um corpo conhecido.
      // `connection: close` porque o `fetch` do Node mantém o socket vivo no
      // pool do undici, e o pool sozinho já segura o processo do Jest.
      const resposta = await fetch(
        `http://127.0.0.1:${PORTA}${CONTROLE.rota}`,
        {
          headers: { connection: 'close' },
        },
      );
      expect(resposta.status).toBe(CONTROLE.status);
      expect((await resposta.text()).trim()).toBe(CONTROLE.corpo);

      // ---- 7. e continua vivo DEPOIS de responder
      expect(filho.exitCode).toBeNull();
    } catch (erro) {
      primaria = erro;
      throw erro;
    } finally {
      // ---- 8. limpeza, e ela NÃO pode engolir a falha original.
      const falhasDaLimpeza: unknown[] = [];

      if (filho && filho.exitCode === null) {
        const saiu = new Promise<void>((resolve) =>
          filho?.once('exit', () => resolve()),
        );
        // **Só o PID que este teste criou.** Nunca por nome de imagem.
        filho.kill('SIGTERM');
        // O timer precisa ser CANCELADO quando o filho sai antes dele. Sem
        // isso sobra um `setTimeout` de 5 s vivo, e o Jest avisa "did not exit
        // one second after the test run has completed" — verde, com resto.
        let desistir: NodeJS.Timeout | undefined;
        const desistiu = new Promise<'tarde'>((r) => {
          desistir = setTimeout(() => r('tarde'), PRAZO_DE_SAIDA_MS);
        });
        try {
          const quem = await Promise.race([saiu.then(() => 'saiu'), desistiu]);
          if (quem === 'tarde') {
            filho.kill('SIGKILL');
            await saiu;
          }
        } finally {
          if (desistir) clearTimeout(desistir);
        }
      }

      if (bancoCriado) {
        try {
          const admin = new PrismaClient({ datasourceUrl: urlAdmin });
          await admin.$executeRawUnsafe(
            `DROP DATABASE IF EXISTS "${nome}" WITH (FORCE)`,
          );
          await admin.$disconnect();
        } catch (erro) {
          falhasDaLimpeza.push(erro);
        }
      }

      if (falhasDaLimpeza.length > 0) {
        // A **primária** sobe; a do cleanup vai anexada. Trocar o diagnóstico
        // certo por um errado é o defeito mais caro de depurar, e foi ressalva
        // da 8ª rodada.
        //
        // **O `no-unsafe-finally` está certo em geral, e desligado aqui de
        // propósito.** A regra existe porque `throw` num `finally` DESCARTA a
        // exceção em curso — e é exatamente isso que o `AggregateError` abaixo
        // impede: ele CARREGA a primária como primeiro elemento. Sem o `throw`,
        // uma limpeza que falha some em silêncio, que é o defeito oposto.
        // eslint-disable-next-line no-unsafe-finally
        throw new AggregateError(
          primaria ? [primaria, ...falhasDaLimpeza] : falhasDaLimpeza,
          primaria
            ? 'o teste falhou E a limpeza falhou — a primeira é a de cima'
            : 'o teste passou, mas a limpeza falhou',
        );
      }
    }
  });
});
