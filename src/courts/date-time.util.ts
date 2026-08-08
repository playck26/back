// Prisma mapeia colunas @db.Date/@db.Time para JS Date — usamos uma data
// fixa (1970-01-01) como parte "neutra" para colunas @db.Time, já que só a
// hora importa (mesma convenção usada nas duas pontas: escrita e leitura).
const TIME_BASE_DATE = '1970-01-01';

// Janela de expediente fixa no MVP (06h-22h) — não há campo de horário de
// funcionamento configurável em DATA_MODEL.md; assumido como simplificação
// razoável, registrado como gap em STATUS.md. Usada tanto pela grade de
// disponibilidade (courts.service.ts) quanto pelo denominador de
// `ocupacaoQuadrasPct` do dashboard (dashboard.service.ts).
export const EXPEDIENTE_INICIO_HORA = 6;
export const EXPEDIENTE_FIM_HORA = 22;

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
  const hojeUTC = new Date(
    Date.UTC(
      referencia.getUTCFullYear(),
      referencia.getUTCMonth(),
      referencia.getUTCDate(),
    ),
  );
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
