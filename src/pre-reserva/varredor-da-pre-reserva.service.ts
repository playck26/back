import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { HorarioFuncionamentoService } from '../courts/horario-funcionamento.service';
import { formatDateOnly, formatTimeOnly } from '../courts/date-time.util';
import { SeletorDoLote, type SlotDoLote } from './seletor-do-lote';
import {
  TIPO_PRE_RESERVA,
  montarAvisoDaPreReserva,
} from './aviso-da-pre-reserva';

/** O que um ciclo fez — **só números**, nenhum id, nome ou credencial. */
export interface ResultadoDoCicloDaPreReserva {
  expiradas: number;
  encerradas: number;
  candidatos: number;
  slotsPendentes: number;
  examinados: number;
  avisadas: number;
  duracaoMs: number;
}

/**
 * SPEC-074/D3 e D7 — **o varredor: quem avisa é ele, nunca o gesto.**
 *
 * ## Por que um varredor
 *
 * Um horário vaga por **cinco** caminhos (`cancelBooking`,
 * `updatePaymentStatus`, `cancelOneClassOccurrence`,
 * `cancelFutureClassOccupancies`, `moveBooking`). Avisar dentro do gesto
 * exigiria mexer nos cinco — todos em `ocupacoes_quadra`, a tabela mais
 * crítica — **e lembrar do sexto** quando alguém o escrever. O varredor
 * pergunta pelo ESTADO, e o estado não depende de quem o mudou. A lista dos
 * cinco é cobertura de regressão (AC-007), não prova de completude.
 *
 * ## `ocupacoes_quadra` é só LIDA, e sem `FOR UPDATE` (INV-074g)
 *
 * O varredor fica fora da ordem canônica de locks porque não trava nenhuma
 * tabela dela. A AC-021 fica vermelha no dia em que alguém puser `FOR UPDATE`
 * na leitura de sobreposição.
 *
 * ## O relógio é o do BANCO
 *
 * `now()` no SQL, uma fonte só: o SQL compara `inicio_em` com `now()` e não
 * conhece fuso (D6). Por isso `executarCiclo()` não recebe relógio — nem
 * parâmetro nenhum que só a suíte use.
 *
 * ## "Exatamente um aviso" — quatro peças, redundância declarada
 *
 * | Peça | O papel que só ela cumpre | Prova |
 * |---|---|---|
 * | `FOR UPDATE SKIP LOCKED` | a segunda réplica não ESPERA: pula o slot da primeira | AC-024 |
 * | a transição com `RETURNING` | só quem a transição MUDOU recebe aviso — não o encerrado no 4.3 | AC-025 |
 * | `ON CONFLICT … DO NOTHING` | a duplicata não aborta a transação: vira contagem | AC-026 |
 * | o índice único + o CHECK | a duplicata não persiste, nem por SQL direto | AC-026 |
 */
@Injectable()
export class VarredorDaPreReservaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seletor: SeletorDoLote,
    private readonly horarios: HorarioFuncionamentoService,
  ) {}

  async executarCiclo(): Promise<ResultadoDoCicloDaPreReserva> {
    const inicio = Date.now();
    const r: ResultadoDoCicloDaPreReserva = {
      expiradas: 0,
      encerradas: 0,
      candidatos: 0,
      slotsPendentes: 0,
      examinados: 0,
      avisadas: 0,
      duracaoMs: 0,
    };

    // 1 — EXPIRAR: o horário começou sem vagar. **Por `SKIP LOCKED`**: uma
    // linha travada por outra réplica está sendo processada por ela, e este
    // ciclo não espera (a disciplina que a 2ª rodada pediu às etapas globais).
    r.expiradas = await this.prisma.$executeRaw`
      UPDATE pre_reservas
         SET estado = 'expirada', concluida_em = now(),
             motivo_fim = 'o horario comecou'
       WHERE id IN (
         SELECT id FROM pre_reservas
          WHERE estado = 'aguardando' AND inicio_em <= now()
          FOR UPDATE SKIP LOCKED)`;

    // 2 — RESERVOU SOZINHO: quem viu o horário livre na tela e reservou antes
    // do ciclo não pode ficar com um aviso "ativo" para a própria reserva.
    r.encerradas += await this.prisma.$executeRaw`
      UPDATE pre_reservas
         SET estado = 'encerrada', concluida_em = now(), motivo_fim = 'reservou'
       WHERE id IN (
         SELECT p.id FROM pre_reservas p
          WHERE p.estado = 'aguardando'
            AND EXISTS (
              SELECT 1 FROM ocupacoes_quadra o
               WHERE o.company_id = p.company_id
                 AND o.quadra_id = p.quadra_id
                 AND o.data = p.data
                 AND o.status_pagamento <> 'cancelado'
                 AND o.origem_tipo = 'AVULSO'
                 AND o.aluno_id = p.aluno_id
                 AND o.hora_inicio < p.hora_fim
                 AND o.hora_fim > p.hora_inicio)
          FOR UPDATE OF p SKIP LOCKED)`;

    // 3 — O LOTE: as duas contagens e os slots, do mesmo instante.
    const { candidatos, slotsPendentes, lote } =
      await this.seletor.selecionar();
    r.candidatos = candidatos;
    r.slotsPendentes = slotsPendentes;

    // 4 — POR SLOT.
    for (const slot of lote) {
      r.examinados += 1;
      const horario = await this.horarios.resolverParaData(
        slot.companyId,
        slot.quadraId,
        slot.data,
      );
      if (
        !this.horarios.dentroDoExpediente(
          horario,
          slot.horaInicio,
          slot.horaFim,
        )
      ) {
        // Reprovou no expediente: vai para o FIM do rodízio. É isto que impede
        // a inanição — o lote seguinte vê outros slots.
        await this.marcarVerificado(this.prisma, slot);
        continue;
      }
      const desfecho = await this.avisarNoSlot(slot);
      r.avisadas += desfecho.avisadas;
      r.encerradas += desfecho.encerradas;
    }

    r.duracaoMs = Date.now() - inicio;
    return r;
  }

  /**
   * `verificada_em = now()` nas linhas vivas do slot — **por `SKIP LOCKED`**,
   * nunca esperando a réplica que as está processando.
   */
  private async marcarVerificado(
    cliente: PrismaService | Prisma.TransactionClient,
    slot: SlotDoLote,
  ): Promise<void> {
    await cliente.$executeRaw`
      UPDATE pre_reservas SET verificada_em = now()
       WHERE id IN (
         SELECT id FROM pre_reservas
          WHERE company_id = ${slot.companyId}::uuid
            AND quadra_id = ${slot.quadraId}::uuid
            AND data = ${formatDateOnly(slot.data)}::date
            AND hora_inicio = ${formatTimeOnly(slot.horaInicio)}::time
            AND estado = 'aguardando'
          FOR UPDATE SKIP LOCKED)`;
  }

  /**
   * D7/4, **em transação própria por slot.**
   *
   * **Data e hora vão como TEXTO, com `::date`/`::time`, e não como `Date`** —
   * a regra que o `courts.service.ts` já registra: um `Date` chega como
   * timestamp, e o cast passa a depender do fuso da SESSÃO (DEF-020).
   */
  private async avisarNoSlot(
    slot: SlotDoLote,
  ): Promise<{ avisadas: number; encerradas: number }> {
    return this.prisma.$transaction(async (tx) => {
      // 4.1 — A AQUISIÇÃO. O `SELECT … FOR UPDATE` relê `estado` depois do
      // lock (READ COMMITTED): um pedido cancelado entre o lote e aqui não
      // volta. O `SKIP LOCKED` faz a segunda réplica PULAR, não esperar.
      const adquiridas = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM pre_reservas
         WHERE company_id = ${slot.companyId}::uuid
           AND quadra_id = ${slot.quadraId}::uuid
           AND data = ${formatDateOnly(slot.data)}::date
           AND hora_inicio = ${formatTimeOnly(slot.horaInicio)}::time
           AND estado = 'aguardando'
         FOR UPDATE SKIP LOCKED`;
      if (adquiridas.length === 0) return { avisadas: 0, encerradas: 0 };
      const ids = adquiridas.map((a) => a.id);

      // 4.2 — RELÊ a sobreposição, SEM lock (INV-074g): a leitura do lote pode
      // ter envelhecido. Voltou a ser ocupado → só vai para o fim do rodízio.
      const [ocupado] = await tx.$queryRaw<{ ocupado: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM ocupacoes_quadra o
           WHERE o.company_id = ${slot.companyId}::uuid
             AND o.quadra_id = ${slot.quadraId}::uuid
             AND o.data = ${formatDateOnly(slot.data)}::date
             AND o.status_pagamento <> 'cancelado'
             AND o.hora_inicio < ${formatTimeOnly(slot.horaFim)}::time
             AND o.hora_fim > ${formatTimeOnly(slot.horaInicio)}::time) AS ocupado`;
      if (ocupado.ocupado) {
        await tx.$executeRaw`
          UPDATE pre_reservas SET verificada_em = now()
           WHERE id = ANY(${ids}::uuid[])`;
        return { avisadas: 0, encerradas: 0 };
      }

      // 4.3 — quem deixou de operar é ENCERRADO, sem aviso: o horário não
      // poderia virar reserva dele (a mesma trava de reservar, D2).
      const encerradas = await tx.$executeRaw`
        UPDATE pre_reservas p
           SET estado = 'encerrada', concluida_em = now(),
               motivo_fim = 'aluno deixou de operar'
          FROM alunos a
         WHERE p.id = ANY(${ids}::uuid[])
           AND p.estado = 'aguardando'
           AND a.company_id = p.company_id AND a.id = p.aluno_id
           AND NOT (a.vinculo = 'aprovado' AND a.status = 'ativo')`;

      // 4.4 — A TRANSIÇÃO. **Os avisos saem do `RETURNING`, e só dele**
      // (INV-074i): quem o 4.3 encerrou foi adquirido e NÃO está aqui.
      const avisadas = await tx.$queryRaw<
        {
          id: string;
          company_id: string;
          usuario_id: string;
          quadra_id: string;
          data: Date;
          hora_inicio: Date;
          inicio_em: Date;
        }[]
      >`
        UPDATE pre_reservas p
           SET estado = 'avisada', avisada_em = now(), concluida_em = now(),
               verificada_em = now()
          FROM alunos a
         WHERE p.id = ANY(${ids}::uuid[])
           AND p.estado = 'aguardando'
           AND a.company_id = p.company_id AND a.id = p.aluno_id
        RETURNING p.id, p.company_id, a.usuario_id, p.quadra_id, p.data,
                  p.hora_inicio, p.inicio_em`;

      // 4.5 — UM aviso por linha do `RETURNING`. `ON CONFLICT … DO NOTHING`
      // (B-02 da 1ª rodada): a duplicata é contagem zero, não um `23505` que
      // abortaria esta transação inteira.
      let inseridos = 0;
      for (const linha of avisadas) {
        const aviso = montarAvisoDaPreReserva({
          quadraId: linha.quadra_id,
          data: linha.data,
          horaInicio: linha.hora_inicio,
          inicioEm: linha.inicio_em,
        });
        inseridos += await tx.$executeRaw`
          INSERT INTO notificacoes
            (id, company_id, destinatario_id, origem_id, tipo, titulo, corpo,
             destino_url, expira_em)
          VALUES (${crypto.randomUUID()}::uuid, ${linha.company_id}::uuid,
                  ${linha.usuario_id}::uuid, ${linha.id}::uuid,
                  ${TIPO_PRE_RESERVA}, ${aviso.titulo}, ${aviso.corpo},
                  ${aviso.destinoUrl}, ${aviso.expiraEm})
          ON CONFLICT (origem_id, destinatario_id)
            WHERE tipo = 'pre_reserva' DO NOTHING`;
      }
      return { avisadas: inseridos, encerradas };
    });
  }
}
