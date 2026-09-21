import { FUSO_DO_CLUBE, instanteNoFusoDoClube } from '../courts/date-time.util';

/**
 * SPEC-064/D7 — **o texto do chamado, e por que ele não é um aviso de gesto.**
 *
 * ## `tipo = 'lista_espera'`, e a caixa o mostra sem uma linha de código novo
 *
 * A caixa de entrada da SPEC-065 recorta por **lista de exclusão**
 * (`tipo <> 'teste'`), não por allowlist — e a SPEC-065/D6 tomou essa decisão
 * **pensando nesta spec**:
 *
 * > *"com uma allowlist, a SPEC-064 teria de lembrar de acrescentar o `tipo`
 * > dela, e esquecer significaria a pessoa não ver um aviso que recebeu"*
 *
 * ## O que esta spec herda, e o que não herda
 *
 * | Regra | Aqui |
 * |---|---|
 * | o `titulo` de `tipo='gesto'` vem de vocabulário fechado (SPEC-063/AC-018) | **não se aplica** — o chamado não é gesto. Mas entra na mesma bandeja, então o título é escolha nomeada: **`Sua vez`** |
 * | o corpo nunca leva texto livre de tabela (INV-063a) | **vale igual**: nada de `Turma.nome`. Dia, hora e prazo |
 * | `destino_url` carrega **id**, nunca slug | **vale igual** |
 * | `expira_em` é do ENVIO, não da caixa | `expira_em = chamado_ate`: o push para de tentar quando a vez vence, e a caixa continua mostrando |
 *
 * **`Sua vez` não entra na lista fechada da AC-018**, e a separação é
 * deliberada: *invariante que atropela o vizinho é invariante que alguém
 * desliga.*
 */

/** O `tipo` da linha em `notificacoes`. Fora de `gesto`, e fora de `teste`. */
export const TIPO_LISTA_ESPERA = 'lista_espera';

/** O quarto valor da bandeja, ao lado de `Reservas`, `Sua aula`, `Sua turma`. */
export const TITULO_DO_CHAMADO = 'Sua vez';

export interface FatosDoChamado {
  /** `turma` = vaga de matrícula; `aula` = vaga de reposição. */
  fila: 'turma' | 'aula';
  /** O alvo, para a URL. Sempre id, nunca nome. */
  turmaId: string | null;
  /** Data e hora da aula — presentes só quando há ocorrência conhecida. */
  data: Date | null;
  horaInicio: Date | null;
  /** Até quando a vez vale. */
  chamadoAte: Date;
}

export interface AvisoDoChamado {
  titulo: string;
  corpo: string;
  destinoUrl: string;
  expiraEm: Date;
}

/**
 * "quinta (19h)" / "quinta (19h30)" — a mesma forma dos avisos de gesto, e de
 * propósito: duas gramáticas de data na mesma bandeja é a pessoa tendo de
 * aprender duas.
 */
function quando(data: Date, horaInicio: Date): string {
  const instante = instanteNoFusoDoClube(data, horaInicio);
  const dia = new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO_DO_CLUBE,
    weekday: 'long',
  })
    .format(instante)
    .replace(/-feira$/, '');
  const [hh, mm] = new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO_DO_CLUBE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
  })
    .format(instante)
    .split(':');
  return `${dia} (${mm === '00' ? `${hh}h` : `${hh}h${mm}`})`;
}

/** "até quinta às 19h" — o prazo da vez, no fuso do clube. */
function ate(chamadoAte: Date): string {
  const dia = new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO_DO_CLUBE,
    weekday: 'long',
  })
    .format(chamadoAte)
    .replace(/-feira$/, '');
  const [hh, mm] = new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO_DO_CLUBE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
  })
    .format(chamadoAte)
    .split(':');
  return `${dia} às ${mm === '00' ? `${hh}h` : `${hh}h${mm}`}`;
}

/**
 * **O texto diz que a vaga NÃO está reservada** (LIM-064a), e isso não é
 * delicadeza: a fila é convite para tentar primeiro, e alguém pode levar a vaga
 * pela tela normal durante o prazo (LIM-064f). Um aviso que dissesse *"sua vaga
 * está garantida"* produziria a recusa que a pessoa não entende.
 */
export function montarAvisoDoChamado(fatos: FatosDoChamado): AvisoDoChamado {
  const prazo = ate(fatos.chamadoAte);

  const corpo =
    fatos.fila === 'aula'
      ? fatos.data && fatos.horaInicio
        ? `Abriu vaga na aula de ${quando(fatos.data, fatos.horaInicio)}. Garanta até ${prazo} — quem marcar primeiro fica com ela.`
        : `Abriu vaga na aula. Garanta até ${prazo} — quem marcar primeiro fica com ela.`
      : `Abriu vaga na sua turma de espera. Garanta até ${prazo} — quem entrar primeiro fica com ela.`;

  return {
    titulo: TITULO_DO_CHAMADO,
    corpo,
    // Id, nunca slug (SPEC-063/AC-007). Não há rota de UMA ocorrência na visão
    // do aluno, então a fila de aula cai na lista — mesma escolha do
    // `aula_cancelada`.
    destinoUrl:
      fatos.fila === 'aula'
        ? '/minhas-aulas'
        : fatos.turmaId
          ? `/minhas-aulas/turma/${fatos.turmaId}`
          : '/minhas-aulas/turmas',
    // **Do ENVIO, não da caixa** (SPEC-065/D7). Passou a vez, não adianta mais
    // tentar entregar o push; a linha continua legível em `/avisos`.
    expiraEm: fatos.chamadoAte,
  };
}
