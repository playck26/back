import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  EXPEDIENTE_FIM_HORA,
  EXPEDIENTE_INICIO_HORA,
  parseTimeOnly,
} from './date-time.util';

export interface SlotCanonico {
  inicio: Date;
  fim: Date;
}

export type HorarioEfetivo =
  { estado: 'fechado' } | { estado: 'aberto'; horaInicio: Date; horaFim: Date };

type PrismaLike = Pick<PrismaService, 'horarioFuncionamento'>;

/**
 * SPEC-010 (MOD-005) — **a única fonte de verdade sobre "estar aberto"**.
 *
 * `availability` e a validação de criação de ocupação usam este mesmo
 * serviço de propósito. Se cada uma resolvesse o horário por conta
 * própria, elas divergiriam com o tempo — e o sintoma seria o pior
 * possível: o app oferece um horário que o servidor recusa depois
 * (REQ-008/AC-015).
 */
@Injectable()
export class HorarioFuncionamentoService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve o horário de uma quadra num dia da semana, aplicando a herança:
   * horário próprio da quadra, se existir; senão o padrão da empresa.
   *
   * **Uma consulta só** (NFR-001): busca as duas linhas possíveis de uma
   * vez e escolhe em memória. Duas consultas em sequência custariam o dobro
   * numa rota chamada a cada troca de dia na tela do aluno.
   */
  async resolver(
    companyId: string,
    quadraId: string,
    diaSemana: number,
    tx: PrismaLike | Prisma.TransactionClient = this.prisma,
  ): Promise<HorarioEfetivo> {
    const linhas = await (tx as PrismaLike).horarioFuncionamento.findMany({
      where: {
        companyId,
        diaSemana,
        OR: [{ quadraId }, { quadraId: null }],
      },
    });

    // Herança: a linha da quadra vence a da empresa. Quadra que segue o
    // padrão simplesmente não tem linha própria — por isso a herança
    // acompanha mudanças no padrão sem nenhuma escrita nas quadras
    // (REQ-003/AC-005).
    const doQuadra = linhas.find((l) => l.quadraId === quadraId);
    const daEmpresa = linhas.find((l) => l.quadraId === null);
    const efetivo = doQuadra ?? daEmpresa;

    if (!efetivo) {
      // Rede de segurança para empresa sem configuração alguma: mantém o
      // comportamento anterior à SPEC-010 (6h–22h) em vez de fechar a
      // agenda. Fechar seria "seguro" e erraria feio — uma empresa sem
      // linha configurada ficaria invisível para os próprios alunos sem
      // ninguém entender por quê. `CompaniesService` semeia o padrão na
      // criação, então isto só cobre dado legado ou corrompido.
      return {
        estado: 'aberto',
        horaInicio: parseTimeOnly(
          `${String(EXPEDIENTE_INICIO_HORA).padStart(2, '0')}:00`,
        ),
        horaFim: parseTimeOnly(
          `${String(EXPEDIENTE_FIM_HORA).padStart(2, '0')}:00`,
        ),
      };
    }

    if (efetivo.fechado || !efetivo.horaInicio || !efetivo.horaFim) {
      return { estado: 'fechado' };
    }

    return {
      estado: 'aberto',
      horaInicio: efetivo.horaInicio,
      horaFim: efetivo.horaFim,
    };
  }

  /** Conveniência: resolve a partir de uma data (0 = domingo, `getUTCDay`). */
  resolverParaData(
    companyId: string,
    quadraId: string,
    data: Date,
    tx?: PrismaLike | Prisma.TransactionClient,
  ): Promise<HorarioEfetivo> {
    return this.resolver(companyId, quadraId, data.getUTCDay(), tx);
  }

  /**
   * Slots canônicos de 1 hora dentro do expediente. Dia fechado não tem
   * slot — e isso é resposta legítima, não erro (AC-008).
   *
   * A duração fixa de 1 hora é decisão do usuário registrada na SPEC-010
   * (GAP-003 segue aberto). Como o horário só existe em hora cheia
   * (AC-014), o último slot sempre termina exatamente no fechamento.
   */
  gerarSlots(horario: HorarioEfetivo): SlotCanonico[] {
    if (horario.estado === 'fechado') {
      return [];
    }

    const slots: SlotCanonico[] = [];
    const inicioHora = horario.horaInicio.getUTCHours();
    const fimHora = horario.horaFim.getUTCHours();

    for (let hora = inicioHora; hora < fimHora; hora++) {
      slots.push({
        inicio: parseTimeOnly(`${String(hora).padStart(2, '0')}:00`),
        fim: parseTimeOnly(`${String(hora + 1).padStart(2, '0')}:00`),
      });
    }
    return slots;
  }

  /**
   * SPEC-010/REQ-010 — estar dentro do expediente é **fechado nas duas
   * pontas**: `horaInicio >= abertura` e `horaFim <= fechamento`.
   *
   * Não confundir com a detecção de conflito entre ocupações, que é
   * **semiaberta** (`09:00–10:00` não colide com `10:00–11:00`). As duas
   * regras estão certas e são diferentes: com expediente `06:00–10:00`, a
   * ocupação `10:00–11:00` não conflita com `09:00–10:00`, mas está fora
   * do expediente (AC-020 a AC-022).
   */
  dentroDoExpediente(
    horario: HorarioEfetivo,
    horaInicio: Date,
    horaFim: Date,
  ): boolean {
    if (horario.estado === 'fechado') {
      return false;
    }
    return (
      horaInicio.getTime() >= horario.horaInicio.getTime() &&
      horaFim.getTime() <= horario.horaFim.getTime()
    );
  }
}
