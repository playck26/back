import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { buildUsuarioAtivo, loginAndGetTokens } from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { bodyOf } from './utils/http';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

/**
 * SPEC-040/TASK-004 — os sete ACs da disponibilidade, na camada HTTP.
 *
 * **O que este arquivo prova, e o que ele NÃO prova.** Aqui o Prisma é
 * mockado: exercita guard, controller, DTO e as três recusas com código —
 * decisões que só existem no HTTP. Que o banco RECUSE "atende das 10h às 8h"
 * é outro assunto, e está em `test/banco/disponibilidade-professor.db-spec.ts`
 * contra Postgres real, porque mock não tem `CHECK`.
 */
const PROFESSOR = '33333333-3333-4333-8333-333333333333';
const ROTA = `/api/v1/teachers/${PROFESSOR}/disponibilidade`;

describe('Disponibilidade do professor (e2e) — SPEC-040', () => {
  let app: INestApplication<App>;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    app = await createTestApp(prisma);
  });

  afterEach(async () => {
    await app.close();
  });

  async function comoAdmin() {
    const usuario = await buildUsuarioAtivo();
    const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
    return accessToken;
  }

  const put = (token: string, dias: unknown[]) =>
    request(app.getHttpServer())
      .put(ROTA)
      .set('Authorization', `Bearer ${token}`)
      .send({ dias });

  it('AC-001: o PUT apaga a semana e recria, na MESMA transação', async () => {
    const token = await comoAdmin();
    await put(token, [
      { diaSemana: 1, horaInicio: '08:00', horaFim: '12:00' },
      { diaSemana: 3, horaInicio: '14:00', horaFim: '18:00' },
    ]).expect(200);

    // **A asserção é sobre o `tx`, não sobre o `prisma`.** Um `deleteMany`
    // fora da transação deixaria a grade vazia se o `createMany` falhasse —
    // e é justamente o estado meio-salvo que o `PUT` existe para não criar.
    expect(prisma.tx.disponibilidadeProfessor.deleteMany).toHaveBeenCalledTimes(
      1,
    );
    const [args] = prisma.tx.disponibilidadeProfessor.createMany.mock
      .calls[0] as [{ data: { diaSemana: number }[] }];
    expect(args.data.map((d) => d.diaSemana)).toEqual([1, 3]);
  });

  it('AC-002: `dias: []` apaga a semana e NÃO chama createMany', async () => {
    const token = await comoAdmin();
    await put(token, []).expect(200);

    expect(prisma.tx.disponibilidadeProfessor.deleteMany).toHaveBeenCalledTimes(
      1,
    );
    // `createMany` com lista vazia seria uma ida ao banco sem efeito — e
    // esconderia, de quem lê o log, que a semana foi zerada de propósito.
    expect(
      prisma.tx.disponibilidadeProfessor.createMany,
    ).not.toHaveBeenCalled();
  });

  it('AC-003: hora fim menor ou igual ao início devolve 422 INTERVALO_INVALIDO', async () => {
    const token = await comoAdmin();
    const resposta = await put(token, [
      { diaSemana: 2, horaInicio: '12:00', horaFim: '08:00' },
    ]).expect(422);

    expect(bodyOf<{ code: string }>(resposta).code).toBe('INTERVALO_INVALIDO');
    // Nada foi escrito: a recusa acontece ANTES da transação abrir.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('AC-003: fim IGUAL ao início também é recusado', async () => {
    const token = await comoAdmin();
    const resposta = await put(token, [
      { diaSemana: 2, horaInicio: '09:00', horaFim: '09:00' },
    ]).expect(422);
    expect(bodyOf<{ code: string }>(resposta).code).toBe('INTERVALO_INVALIDO');
  });

  it('AC-004: minuto diferente de zero devolve 422 HORA_NAO_CHEIA', async () => {
    const token = await comoAdmin();
    const resposta = await put(token, [
      { diaSemana: 4, horaInicio: '08:30', horaFim: '12:00' },
    ]).expect(422);

    expect(bodyOf<{ code: string }>(resposta).code).toBe('HORA_NAO_CHEIA');
  });

  it('AC-004 vem ANTES da AC-003: `10:30`–`08:15` acusa a hora, não o intervalo', async () => {
    const token = await comoAdmin();
    const resposta = await put(token, [
      { diaSemana: 4, horaInicio: '10:30', horaFim: '08:15' },
    ]).expect(422);

    // As duas regras estão violadas. A ordem importa porque `parseTimeOnly`
    // de uma hora quebrada produz um `Date` VÁLIDO: se o intervalo fosse
    // julgado primeiro, o gestor consertaria o horário e receberia um
    // segundo erro sobre o mesmo campo.
    expect(bodyOf<{ code: string }>(resposta).code).toBe('HORA_NAO_CHEIA');
  });

  it('AC-005: dia repetido devolve 422 DIA_REPETIDO, sem tocar o banco', async () => {
    const token = await comoAdmin();
    const resposta = await put(token, [
      { diaSemana: 1, horaInicio: '08:00', horaFim: '12:00' },
      { diaSemana: 1, horaInicio: '14:00', horaFim: '18:00' },
    ]).expect(422);

    expect(bodyOf<{ code: string }>(resposta).code).toBe('DIA_REPETIDO');
    // Sem esta recusa, o índice único responderia `23505` — erro de banco
    // vazando como `500`, que na tela é "erro do servidor" e no suporte é
    // um chamado.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('AC-006: professor de outra empresa devolve 404, nunca 403', async () => {
    const token = await comoAdmin();
    prisma.professor.findFirst.mockResolvedValue(null);

    await put(token, [
      { diaSemana: 1, horaInicio: '08:00', horaFim: '12:00' },
    ]).expect(404);

    await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('AC-007: o GET devolve SEMPRE os sete dias, com indisponivel nos vazios', async () => {
    const token = await comoAdmin();
    prisma.disponibilidadeProfessor.findMany.mockResolvedValue([
      {
        diaSemana: 1,
        horaInicio: new Date('1970-01-01T08:00:00.000Z'),
        horaFim: new Date('1970-01-01T12:00:00.000Z'),
      },
    ]);

    const resposta = await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const dias = bodyOf<
      {
        diaSemana: number;
        indisponivel: boolean;
        horaInicio: string | null;
      }[]
    >(resposta);
    expect(dias).toHaveLength(7);
    expect(dias[1]).toEqual({
      diaSemana: 1,
      indisponivel: false,
      horaInicio: '08:00',
      horaFim: '12:00',
    });
    // Os outros seis: a tela não deveria ter de saber que ausência de linha
    // significa alguma coisa.
    expect(dias.filter((d) => d.indisponivel)).toHaveLength(6);
    expect(dias[0].horaInicio).toBeNull();
  });

  it('rota fechada para quem não é gestor da empresa', async () => {
    await request(app.getHttpServer()).get(ROTA).expect(401);
  });
});
