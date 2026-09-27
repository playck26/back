/**
 * SPEC-077/TASK-000 — **sonda de bomba de data.** Não roda no CI.
 *
 * Adianta o relógio do Node para 2027-06-01 e deixa os timers reais (o Prisma
 * precisa deles). Um teste que passa hoje e cai SÓ com esta sonda depende de
 * uma data fixa que o tempo vai vencer — foi assim que a `fit-022` e a
 * `fit-024` apareceram, antes de quebrarem o CI em 2026-10-05 e 2026-12-10.
 *
 * Uso (Git Bash, no `apps/Back`):
 *   node node_modules/jest/bin/jest.js --setupFilesAfterEnv=../test/sonda-relogio-adiantado.js
 *   node node_modules/jest/bin/jest.js --config ./test/jest-e2e.json --setupFilesAfterEnv=./sonda-relogio-adiantado.js
 *   DATABASE_URL=… node node_modules/jest/bin/jest.js --config ./test/jest-banco.json --runInBand --setupFilesAfterEnv=./sonda-relogio-adiantado.js
 *
 * Para rodar só alguns arquivos, ponha `--runTestsByPath` antes deles: sem
 * isso o Jest os lê como mais entradas do `--setupFilesAfterEnv`.
 *
 * Limite: o relógio do BANCO (`now()`) não se adianta. Um teste que cai sob a
 * sonda pode ser bomba de data OU mistura de relógios; a diferença se decide
 * lendo o caso.
 */
jest.useFakeTimers({
  now: new Date('2027-06-01T15:00:00.000Z'),
  doNotFake: [
    'nextTick',
    'setImmediate',
    'clearImmediate',
    'setInterval',
    'clearInterval',
    'setTimeout',
    'clearTimeout',
    'queueMicrotask',
  ],
});
