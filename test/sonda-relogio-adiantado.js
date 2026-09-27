/**
 * SPEC-077/TASK-000 — **sonda de bomba de data.** Não roda no CI.
 *
 * Adianta o relógio do Node e deixa os timers reais (o Prisma precisa deles).
 * O padrão é **2099-09-01**: as rotas validam data com `^20\d{2}-…`, então de
 * 2100 em diante tudo é recusado por construção — limite do produto, e não
 * bomba —, e a folga de meses deixa as fixturas relativas (hoje + N dias)
 * ainda em 2099. `SONDA_RELOGIO` troca o instante.
 *
 * Um teste que passa hoje e cai SÓ com esta sonda depende de uma data fixa que
 * o tempo vai vencer — foi assim que a `fit-022` e a `fit-024` apareceram,
 * antes de quebrarem o CI em 2026-10-05 e 2026-12-10, e depois as de 2031 a
 * 2099. **Para separar bomba de mistura de relógios, compare CASO POR CASO
 * com a sonda em 2027** (`SONDA_RELOGIO=2027-06-01T15:00:00.000Z`): o que cai
 * nas duas é mistura; o que cai só na de 2099 é data fixa.
 *
 * Uso (Git Bash, no `apps/Back`):
 *   node node_modules/jest/bin/jest.js --setupFilesAfterEnv=../test/sonda-relogio-adiantado.js
 *   node node_modules/jest/bin/jest.js --config ./test/jest-e2e.json --setupFilesAfterEnv=./sonda-relogio-adiantado.js
 *   DATABASE_URL=… node node_modules/jest/bin/jest.js --config ./test/jest-banco.json --runInBand --setupFilesAfterEnv=./sonda-relogio-adiantado.js
 *
 * Para rodar só alguns arquivos, ponha `--runTestsByPath` antes deles: sem
 * isso o Jest os lê como mais entradas do `--setupFilesAfterEnv`.
 *
 * Limites: o relógio do BANCO (`now()`) não se adianta; e um teste que, depois
 * da data vencer, continua VERDE pelo motivo errado não aparece aqui — a sonda
 * vê mudança de resultado, não perda de poder de distinguir.
 */
jest.useFakeTimers({
  now: new Date(process.env.SONDA_RELOGIO ?? '2099-09-01T15:00:00.000Z'),
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
