import type { TipoDeAcao } from '@prisma/client';
import { FUSO_DO_CLUBE, instanteNoFusoDoClube } from '../courts/date-time.util';

/**
 * SPEC-063/TASK-001 — **a matriz da D2, o texto da D4 e o prazo da D5, num
 * lugar só e sem tocar no banco.**
 *
 * ## Por que separado do enfileirador
 *
 * Tudo aqui é função pura: entra `acao.tipo` + fatos, sai `titulo`, `corpo`,
 * `destino_url` e `expira_em`. É o que a spec decidiu, e é a parte que se
 * prova sem subir Postgres — a AC-007 e a AC-018 viram teste de mesa.
 *
 * O enfileirador cuida do resto: quem recebe, e como a linha entra.
 *
 * ## A regra dura da D4, que não é estética
 *
 * **O corpo do aviso NÃO carrega texto escrito por ninguém.** Só fatos que o
 * sistema gera: dia, hora, quantidade. Quem diz *qual* turma é o
 * `destino_url`, que leva à tela certa.
 *
 * `Turma.nome` é texto livre e o clube escolhe. "Turma da Ana" é nome
 * plausível — e aí a INV-063a, que promete nunca transmitir nome de terceiro,
 * cairia pelo caminho mais banal possível. Não há como validar texto livre
 * contra "isso é nome de gente".
 *
 * **O custo é real e aceito:** quem tem duas turmas lê "uma das suas turmas" e
 * precisa tocar para saber qual. É pior de ler e impossível de vazar.
 */

/** O `tipo` com que os avisos desta spec nascem (D3). */
export const TIPO_GESTO = 'gesto';

/**
 * O vocabulário fechado de títulos (D4), e a forma verificável da AC-007.
 *
 * **Fechado não é enfeite:** título fora desta lista é texto vindo de algum
 * lugar, e texto vindo de algum lugar é o que a regra proíbe. A AC-018 varre
 * as linhas `tipo = 'gesto'` contra exatamente estes três valores.
 *
 * O `"Avisos do clube"` do aviso de teste (SPEC-062) é um quarto valor que
 * **não pertence a esta spec** — e é por isso que a AC-018 recorta por `tipo`,
 * e não por tabela: invariante que atropela o vizinho é invariante que alguém
 * desliga.
 */
export const TITULOS_DE_GESTO = ['Reservas', 'Sua aula', 'Sua turma'] as const;

export type TituloDeGesto = (typeof TITULOS_DE_GESTO)[number];

/**
 * Quem um gesto avisa (D1 + D2).
 *
 * `ninguem` é um valor de primeira classe, e não a ausência de um caso: os
 * três tipos de dinheiro estão fora do escopo do card por decisão registrada
 * (LIM-063b), e a AC-016 prova o zero. **Provar o zero é tão importante quanto
 * provar o um** — sem ele, alguém acrescenta um aviso de pagamento por parecer
 * útil e ninguém lembra que isso foi decidido.
 */
export type PublicoDoGesto =
  | 'gestores'
  | 'turma'
  | 'aluno_removido'
  | 'turma_e_professor_anterior'
  | 'ninguem';

/**
 * O papel de quem recebe. **Decide a URL**, porque os três apps são
 * diferentes: o gestor abre o Admin, o aluno e o professor abrem o Cliente —
 * e mesmo entre os dois últimos a rota da turma não é a mesma.
 */
export type PapelDoDestinatario =
  | 'gestor'
  | 'aluno'
  | 'professor'
  /**
   * SPEC-068/D6 — quem **perdeu** a turma. É papel próprio e não `professor`
   * por duas razões, e nenhuma é de estilo: o texto dele é outro ("você não é
   * mais o professor"), e a URL dele é a **lista**, não a turma — ele já não
   * pertence a ela, e mandá-lo para lá seria mandá-lo para um 403. É a mesma
   * decisão que o `turma_aluno_removido` tomou para o aluno removido.
   */
  | 'professor_anterior';

/** O que o serviço de domínio sabe e o texto precisa. */
export interface FatosDoGesto {
  /** Quantos blocos/ocorrências o gesto produziu. Só `reserva_criada` usa. */
  readonly quantidade: number;
  /** A turma alvo, quando há uma. `null` para os gestos de reserva. */
  readonly turmaId: string | null;
  /** `data` da ocorrência (coluna `@db.Date`), quando o gesto tem uma só. */
  readonly data: Date | null;
  /** `hora_inicio` da ocorrência — entra no texto. */
  readonly horaInicio: Date | null;
  /** `hora_fim` da ocorrência — entra no **prazo** (D5). */
  readonly horaFim: Date | null;
}

export interface AvisoMontado {
  readonly titulo: TituloDeGesto;
  readonly corpo: string;
  readonly destinoUrl: string;
  readonly expiraEm: Date | null;
}

/**
 * A matriz da D2: para quem cada um dos treze tipos avisa.
 *
 * **Os treze estão aqui, inclusive os três que não avisam ninguém.** O
 * `Record` completo é de propósito: acrescentar valor ao enum `TipoDeAcao` sem
 * decidir o público **não compila**. Foi a falha que derrubou três rodadas de
 * validação desta spec — a lista coberta "por leitura" sempre esquecia dois.
 */
export const PUBLICO_POR_TIPO: Record<TipoDeAcao, PublicoDoGesto> = {
  reserva_criada: 'gestores',
  reserva_cancelada: 'gestores',
  reserva_movida: 'gestores',
  aula_cancelada: 'turma',
  aula_reativada: 'turma',
  turma_horario_editado: 'turma',
  turma_inativada: 'turma',
  turma_reativada: 'turma',
  // `turma_criada` avisa a turma inteira — e a turma inteira, neste instante,
  // é só o professor: ninguém está matriculado ainda (AC-005). Não é um
  // público diferente, é o mesmo público num momento em que está vazio.
  turma_criada: 'turma',
  turma_aluno_removido: 'aluno_removido',
  // SPEC-068/D6 — dois conjuntos de destinatários para UM gesto: a turma (que
  // continua existindo, com professor novo) e quem saiu dela. Público composto
  // em vez de dois tipos de ação, porque a troca é **um** gesto administrativo
  // — dois tipos produziriam duas ações para um clique.
  turma_professor_alterado: 'turma_e_professor_anterior',
  pagamento_confirmado: 'ninguem',
  credito_lancado: 'ninguem',
  credito_retirado: 'ninguem',
};

/**
 * O prazo de cada aviso (D5). `null` significa "sem prazo", e o TTL vira 24 h.
 *
 * **O fim da ocorrência, e não o início** (achado 03 da 2ª rodada). A v2
 * expirava no começo da aula para evitar "sua aula de ontem mudou". O efeito
 * era o oposto do pretendido: o tick roda a cada 60 s, então um cancelamento
 * feito **dois minutos antes** da aula podia ser varrido como `expirada` sem
 * uma única tentativa de envio — e o cancelamento de última hora é justamente
 * o mais valioso de todos. A regra punha o caso mais importante no pior lugar.
 *
 * **Resumo não tem instante** (achado 02): grade alterada, turma encerrada,
 * criada ou reativada cobrem N ocorrências, e escolher uma delas
 * silenciosamente descartaria o resto. Esses levam `null`.
 */
function prazoDoGesto(tipo: TipoDeAcao, fatos: FatosDoGesto): Date | null {
  const temInstante =
    tipo === 'aula_cancelada' ||
    tipo === 'aula_reativada' ||
    tipo === 'reserva_cancelada' ||
    tipo === 'reserva_movida';

  if (!temInstante || !fatos.data || !fatos.horaFim) {
    return null;
  }
  return instanteNoFusoDoClube(fatos.data, fatos.horaFim);
}

/**
 * "quinta (19h)" — dia da semana e hora, no fuso do clube.
 *
 * Só sai daqui o que o sistema gera. Data e hora **vão** de propósito: são o
 * que torna o aviso útil, e quem quiser privacidade máxima na tela bloqueada
 * tem o interruptor do sistema.
 */
function quando(fatos: FatosDoGesto): string | null {
  if (!fatos.data || !fatos.horaInicio) {
    return null;
  }
  const instante = instanteNoFusoDoClube(fatos.data, fatos.horaInicio);
  const dia = new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO_DO_CLUBE,
    weekday: 'long',
  })
    .format(instante)
    // `pt-BR` devolve "quinta-feira"; o aviso diz "quinta".
    .replace(/-feira$/, '');
  const hora = new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO_DO_CLUBE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
  }).format(instante);
  // "19:00" vira "19h"; "19:30" fica "19h30".
  const [hh, mm] = hora.split(':');
  return `${dia} (${mm === '00' ? `${hh}h` : `${hh}h${mm}`})`;
}

/**
 * A rota de destino, por papel.
 *
 * **O `destino_url` entra na regra da AC-007** (achado R05 da 2ª rodada):
 * tirar o nome do corpo e deixá-lo na URL seria mudar o vazamento de lugar.
 * Por isso a URL carrega **id**, nunca `slug` de texto livre.
 *
 * As rotas são as que existem hoje nos fronts, conferidas arquivo por arquivo
 * — o Admin serve `/agenda` (o grupo `(app)` não entra na URL), e o Cliente
 * separa a visão do aluno (`/minhas-aulas`) da do professor
 * (`/minhas-turmas`). A spec dizia "a agenda do dia", "a aula", "a turma"; a
 * tradução para rota real é desta task, e está registrada no CLI_AUDIT.
 */
function destino(
  tipo: TipoDeAcao,
  papel: PapelDoDestinatario,
  turmaId: string | null,
): string {
  if (papel === 'gestor') {
    return '/agenda';
  }
  // SPEC-068/D6 — **a lista, não a turma.** Ele já não pertence a ela, e a
  // tela dela devolveria 403. Mesma decisão do `turma_aluno_removido` logo
  // abaixo, e a razão é idêntica: URL que leva a um erro não é aviso, é ruído.
  if (papel === 'professor_anterior') {
    return '/minhas-turmas';
  }
  if (papel === 'professor') {
    return turmaId ? `/minhas-turmas/${turmaId}` : '/minhas-turmas';
  }
  // Aluno. **O removido é o caso que a URL precisa tratar à parte:** ele já não
  // pertence à turma, e mandá-lo para a tela dela seria mandá-lo para um 403.
  if (tipo === 'turma_aluno_removido') {
    return '/minhas-aulas/turmas';
  }
  // Não há rota de UMA ocorrência na visão do aluno; a aula vive na lista.
  if (tipo === 'aula_cancelada' || tipo === 'aula_reativada') {
    return '/minhas-aulas';
  }
  return turmaId ? `/minhas-aulas/turma/${turmaId}` : '/minhas-aulas';
}

/** O corpo de cada fato (D4). Sem texto livre de tabela nenhuma. */
function corpoDoGesto(
  tipo: TipoDeAcao,
  fatos: FatosDoGesto,
  papel: PapelDoDestinatario,
): string {
  const momento = quando(fatos);

  switch (tipo) {
    case 'reserva_criada':
      return `Nova reserva · ${fatos.quantidade} ${
        fatos.quantidade === 1 ? 'horário' : 'horários'
      }`;
    case 'reserva_cancelada':
      return momento
        ? `Uma reserva de ${momento} foi cancelada`
        : 'Uma reserva foi cancelada';
    case 'reserva_movida':
      return 'Uma reserva mudou de horário';
    case 'aula_cancelada':
      return momento
        ? `Sua aula de ${momento} foi cancelada`
        : 'Uma das suas aulas foi cancelada';
    case 'aula_reativada':
      return momento
        ? `Sua aula de ${momento} voltou`
        : 'Uma das suas aulas voltou';
    case 'turma_horario_editado':
      return 'A grade de uma das suas turmas mudou';
    case 'turma_inativada':
      return 'Uma das suas turmas foi encerrada';
    case 'turma_criada':
      return 'Você tem uma turma nova';
    case 'turma_reativada':
      return 'Uma das suas turmas voltou';
    case 'turma_aluno_removido':
      return 'Você saiu de uma turma';
    // **O único corpo desta família que depende do PAPEL**, e depende porque
    // os dois lados do mesmo fato são notícias diferentes: para a turma, ela
    // continua e trocou de professor; para quem saiu, ela deixou de ser dele.
    // Nenhum dos dois diz nome de ninguém — a INV-063a vale igual aqui.
    case 'turma_professor_alterado':
      return papel === 'professor_anterior'
        ? 'Você não é mais o professor de uma turma'
        : 'Uma das suas turmas mudou de professor';
    case 'pagamento_confirmado':
    case 'credito_lancado':
    case 'credito_retirado':
      // Inalcançável pelo enfileirador (público `ninguem`), e o `switch`
      // exaustivo é o que garante que continue assim quando o enum crescer.
      throw new Error(`SPEC-063: ${tipo} não avisa ninguém (LIM-063b)`);
  }
}

/** O título de cada fato (D4), do vocabulário fechado. */
function tituloDoGesto(tipo: TipoDeAcao): TituloDeGesto {
  switch (tipo) {
    case 'reserva_criada':
    case 'reserva_cancelada':
    case 'reserva_movida':
      return 'Reservas';
    case 'aula_cancelada':
    case 'aula_reativada':
      return 'Sua aula';
    case 'turma_horario_editado':
    case 'turma_inativada':
    case 'turma_criada':
    case 'turma_reativada':
    case 'turma_aluno_removido':
    case 'turma_professor_alterado':
      // SPEC-068/D5 — o tipo novo cabe no vocabulário fechado que já existe,
      // então a AC-018 da SPEC-063 continua valendo sem remendo. Título novo
      // aqui seria invariante atropelando o vizinho.
      //
      // (O comentário mora DEPOIS do `case`, e não entre os dois: entre eles
      // o `no-fallthrough` do ESLint reclama.)
      return 'Sua turma';
    case 'pagamento_confirmado':
    case 'credito_lancado':
    case 'credito_retirado':
      throw new Error(`SPEC-063: ${tipo} não avisa ninguém (LIM-063b)`);
  }
}

/**
 * Monta o aviso de um gesto para um papel. **Devolve `null` quando o gesto não
 * avisa ninguém** — o chamador não precisa conhecer a LIM-063b.
 */
export function montarAviso(
  tipo: TipoDeAcao,
  papel: PapelDoDestinatario,
  fatos: FatosDoGesto,
): AvisoMontado | null {
  if (PUBLICO_POR_TIPO[tipo] === 'ninguem') {
    return null;
  }
  return {
    titulo: tituloDoGesto(tipo),
    corpo: corpoDoGesto(tipo, fatos, papel),
    destinoUrl: destino(tipo, papel, fatos.turmaId),
    expiraEm: prazoDoGesto(tipo, fatos),
  };
}
