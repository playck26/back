// Prisma mapeia colunas @db.Date/@db.Time para JS Date — usamos uma data
// fixa (1970-01-01) como parte "neutra" para colunas @db.Time, já que só a
// hora importa (mesma convenção usada nas duas pontas: escrita e leitura).
const TIME_BASE_DATE = '1970-01-01';

// Janela de expediente que valia até a SPEC-010, quando o horário de
// funcionamento virou dado configurável (`horarios_funcionamento`).
//
// **Estas constantes deixaram de ser a fonte de verdade.** Sobrevivem em
// dois papéis, os dois explícitos:
//  1. valor do backfill da migration de SPEC-010:TASK-000, para que
//     empresas existentes mantivessem exatamente o comportamento anterior;
//  2. rede de segurança para empresa sem nenhuma linha configurada
//     (`HorarioFuncionamentoService.resolver` e o denominador do
//     dashboard) — fechar a agenda nesse caso seria "seguro" e erraria
//     feio, sumindo a empresa da vista dos próprios alunos.
//
// Quem quiser saber se uma quadra está aberta pergunta a
// `HorarioFuncionamentoService`, não a estas constantes.
export const EXPEDIENTE_INICIO_HORA = 6;
export const EXPEDIENTE_FIM_HORA = 22;

/**
 * SPEC-023 — **o fuso do clube, explícito.**
 *
 * O projeto não tinha fuso em lugar nenhum: `grep -rn "America/"` não
 * devolvia nada, e "hoje" era `Date.UTC(...)` do relógio do servidor. Para
 * quase tudo isso passa despercebido; para a regra "não sai no dia da aula"
 * (REQ-004) não passa.
 *
 * **DEF-020 (2026-08-29) — e este comentário dizia, aqui, que
 * `myUpcomingClasses` continuava em UTC "até hoje".** Ficou escrito uma
 * semana, verde, enquanto o horário aparecia errado no app. Hoje esta é a
 * convenção **única**: sete serviços foram convertidos e o gate em
 * `fuso-do-clube.spec.ts` recusa um oitavo lugar calculando "hoje" sozinho.
 * A lição, pela terceira vez neste projeto: aviso não é mecanismo.
 *
 * **O Brasil é UTC-3, então das 21h à meia-noite locais o UTC já está no dia
 * seguinte.** Aula de terça 19h, aluno tentando sair às 21h30 de segunda:
 * em UTC já é terça, e ele levaria `AULA_HOJE` no dia errado. Aula à noite é
 * o horário mais comum de clube de tênis — o caso raro é o caso normal.
 *
 * Fica **constante e explícita** em vez de vir do relógio do servidor: o
 * servidor roda em UTC (DigitalOcean), e herdar o fuso dele é herdar uma
 * decisão que ninguém tomou. Se um dia houver clube em outro fuso, isto
 * vira campo da empresa — e o lugar de mudar é aqui, um só.
 */
export const FUSO_DO_CLUBE = 'America/Sao_Paulo';

/**
 * A data de "hoje" no fuso do clube, como `Date` de meia-noite UTC — o
 * mesmo formato que as colunas `@db.Date` usam, para comparar sem
 * conversão.
 *
 * `en-CA` porque ele formata como `YYYY-MM-DD`, que é exatamente o que
 * `parseDateOnly` espera. Não é curiosidade: é a forma de pedir a data
 * local sem montar string à mão a partir de partes.
 */
export function hojeNoFusoDoClube(agora: Date = new Date()): Date {
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO_DO_CLUBE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(agora);
  return parseDateOnly(local);
}

/**
 * DEF-020 — o mês corrente no fuso do clube, como `AAAA-MM`.
 *
 * Existe porque duas rotas assumem o mês corrente quando o cliente não
 * manda um (`GET /agenda` do gestor e o período do dashboard), e as duas
 * montavam a string com `getUTCFullYear()/getUTCMonth()`. **Às 21h de 31 de
 * dezembro, isso abre janeiro do ano seguinte** — o gestor pede a agenda e
 * recebe um mês vazio, sem nada na tela explicando por quê.
 */
export function mesCorrenteNoFusoDoClube(agora: Date = new Date()): string {
  return formatDateOnly(hojeNoFusoDoClube(agora)).slice(0, 7);
}

/**
 * DEF-020 — **a data existe mesmo?**
 *
 * `parseDateOnly` monta a data por string ISO, e o JS **normaliza em
 * silêncio**: `2026-04-31` vira 1º de maio, `2026-02-30` vira 2 de março.
 * Uma rota que aceita isso responde com as aulas de um dia que não é o
 * pedido — e responde `200`, que é a pior forma de errar.
 *
 * Validação cruzada da SPEC-026, achado 4. Regex não resolve: `3[01]` não
 * sabe quantos dias tem fevereiro. A única forma honesta é montar e
 * conferir se o que voltou é o que se pediu.
 */
export function dataExiste(data: string): boolean {
  const d = parseDateOnly(data);
  return !Number.isNaN(d.getTime()) && formatDateOnly(d) === data;
}

export function parseDateOnly(data: string): Date {
  return new Date(`${data}T00:00:00.000Z`);
}

export function parseTimeOnly(hora: string): Date {
  return new Date(`${TIME_BASE_DATE}T${hora}:00.000Z`);
}

export function formatTimeOnly(date: Date): string {
  return date.toISOString().slice(11, 16);
}

export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// GAP-007 (TARGET_ARCHITECTURE.md): janela rolante de geração de
// ocupações futuras ao criar/editar turma — confirmada com o usuário em
// 2026-08-09, 8 semanas (SPEC-003:CON-004.1).
export const JANELA_OCUPACOES_TURMA_SEMANAS = 8;

// Gera as N próximas datas (1x/semana) em que `diaSemana` (0=domingo..
// 6=sábado) ocorre a partir de `referencia` (inclusive, se `referencia`
// já cair no dia certo). Usado por MOD-004 para gerar o compromisso de
// horário recorrente de uma turma via `CourtsService.registerClassOccupancy`.
export function gerarDatasSemanaisFuturas(
  diaSemana: number,
  janelaSemanas: number = JANELA_OCUPACOES_TURMA_SEMANAS,
  referencia: Date = new Date(),
): Date[] {
  // DEF-020: `referencia` é um INSTANTE, e o dia dele é lido no fuso do
  // clube. Antes era `getUTCDate()` direto: criar uma turma de segunda às
  // 21h30 de uma segunda-feira fazia o UTC já estar em terça, e a primeira
  // ocorrência pulava para a segunda seguinte — a aula de hoje sumia da
  // grade recém-criada.
  const hojeUTC = hojeNoFusoDoClube(referencia);
  const diaAtual = hojeUTC.getUTCDay();
  const diffDias = (diaSemana - diaAtual + 7) % 7;
  const primeiraOcorrencia = new Date(hojeUTC);
  primeiraOcorrencia.setUTCDate(primeiraOcorrencia.getUTCDate() + diffDias);

  const datas: Date[] = [];
  for (let i = 0; i < janelaSemanas; i++) {
    const data = new Date(primeiraOcorrencia);
    data.setUTCDate(data.getUTCDate() + i * 7);
    datas.push(data);
  }
  return datas;
}
