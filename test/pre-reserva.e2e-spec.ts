import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { buildUsuarioAtivo, loginAndGetTokens } from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';
import {
  hojeNoFusoDoClube,
  parseDateOnly,
  parseTimeOnly,
} from '../src/courts/date-time.util';

/**
 * SPEC-074 — a pré-reserva na camada HTTP.
 *
 * **O que este arquivo prova, e o que NÃO prova.** Aqui vivem as decisões que
 * só existem no HTTP: **quem alcança** cada rota e **a validação do corpo**. As
 * guardas da D2 — ocupado, livre, próprio, expediente, passado, teto — são
 * regras sobre dado real, e estão em `spec-074-pedir.db-spec.ts`.
 *
 * O arquivo sobe pelo `createTestApp`, que importa o `AppModule` inteiro: é
 * também a prova de que o `PreReservaModule` está registrado — o Nest recusa
 * subir com dependência que não resolve. (Que o provider seja o CERTO é outra
 * pergunta, e quem a responde é a AC-030.)
 */
const ROTA = '/api/v1/me/pre-reservas';
const ALUNO_ID = '77777777-7777-4777-8777-777777777777';
const QUADRA_ID = '88888888-8888-4888-8888-888888888888';
const PEDIDO_ID = '99999999-9999-4999-8999-999999999999';

function emDias(dias: number): string {
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
const DIA = emDias(3);

describe('Pré-reserva (e2e) — SPEC-074', () => {
  let app: INestApplication<App>;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    app = await createTestApp(prisma);
  });

  afterEach(async () => {
    await app.close();
  });

  async function como(role: 'aluno' | 'company_admin') {
    const usuario = await buildUsuarioAtivo({ role });
    const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
    // O mesmo `findFirst` serve às duas leituras do serviço: o aluno do token
    // e a trava de aluno operante (vínculo e status).
    prisma.aluno.findFirst.mockResolvedValue({
      id: ALUNO_ID,
      vinculo: 'aprovado',
      status: 'ativo',
    });
    return accessToken;
  }

  /** Um horário ocupado por reserva de outro aluno, na quadra ativa. */
  function horarioOcupado(): void {
    prisma.quadra.findFirst.mockResolvedValue({ status: 'ativa' });
    prisma.ocupacaoQuadra.findMany.mockResolvedValue([
      {
        horaInicio: parseTimeOnly('10:00'),
        horaFim: parseTimeOnly('11:00'),
        origemTipo: 'AVULSO',
        alunoId: 'outro-aluno',
      },
    ]);
    prisma.preReserva.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          ...data,
          estado: 'aguardando',
          criadaEm: new Date(),
        }),
    );
  }

  const corpoValido = () => ({
    quadraId: QUADRA_ID,
    data: DIA,
    horaInicio: '10:00',
  });

  it('o aluno pede aviso de um horário ocupado: 201, e o FIM é o servidor que diz', async () => {
    const token = await como('aluno');
    horarioOcupado();

    const res = await request(app.getHttpServer())
      .post(ROTA)
      .set('Authorization', `Bearer ${token}`)
      .send(corpoValido())
      .expect(201);

    expect(res.body).toMatchObject({
      quadraId: QUADRA_ID,
      data: DIA,
      horaInicio: '10:00',
      horaFim: '11:00',
      estado: 'aguardando',
    });
    // O instante vai gravado, mas NÃO sai na resposta: é do servidor (D6).
    expect(res.body).not.toHaveProperty('inicioEm');
    const [[{ data }]] = prisma.preReserva.create.mock.calls as [
      [{ data: { data: Date; alunoId: string } }],
    ];
    expect(data.data).toEqual(parseDateOnly(DIA));
    expect(data.alunoId).toBe(ALUNO_ID);
  });

  it('GET devolve a lista do aluno', async () => {
    const token = await como('aluno');

    const res = await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toEqual([]);
  });

  it('DELETE de um pedido vivo: 204; de um que não existe ou já terminou: 404', async () => {
    const token = await como('aluno');

    await request(app.getHttpServer())
      .delete(`${ROTA}/${PEDIDO_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    prisma.preReserva.updateMany.mockResolvedValue({ count: 0 });
    await request(app.getHttpServer())
      .delete(`${ROTA}/${PEDIDO_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  // ==========================================================================
  // Quem alcança a rota — `@Roles('aluno')` em CADA método
  // ==========================================================================

  it.each([
    ['GET', () => ROTA],
    ['POST', () => ROTA],
    ['DELETE', () => `${ROTA}/${PEDIDO_ID}`],
  ] as const)('%s é só do aluno: o gestor recebe 403', async (metodo, url) => {
    const token = await como('company_admin');
    horarioOcupado();

    const servidor = request(app.getHttpServer());
    const chamada =
      metodo === 'GET'
        ? servidor.get(url())
        : metodo === 'POST'
          ? servidor.post(url()).send(corpoValido())
          : servidor.delete(url());
    await chamada.set('Authorization', `Bearer ${token}`).expect(403);
    expect(prisma.preReserva.create).not.toHaveBeenCalled();
    expect(prisma.preReserva.updateMany).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // A validação do corpo
  // ==========================================================================

  it.each([
    ['hora que não é cheia', { horaInicio: '10:30' }],
    ['hora fora do relógio', { horaInicio: '24:00' }],
    ['dia que não existe no calendário', { data: '2026-02-30' }],
    ['data com hora junto', { data: `${DIA}T10:00` }],
    ['quadra que não é UUID', { quadraId: 'quadra-1' }],
    [
      'campo a mais (o aluno sai do token, nunca do corpo)',
      { alunoId: ALUNO_ID },
    ],
    ['sem a hora', { horaInicio: undefined }],
  ])('400 — %s', async (_caso, alteracao) => {
    const token = await como('aluno');
    horarioOcupado();

    await request(app.getHttpServer())
      .post(ROTA)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...corpoValido(), ...alteracao })
      .expect(400);
    expect(prisma.preReserva.create).not.toHaveBeenCalled();
  });

  it('400 — DELETE com id que não é UUID', async () => {
    const token = await como('aluno');

    await request(app.getHttpServer())
      .delete(`${ROTA}/nao-e-uuid`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    expect(prisma.preReserva.updateMany).not.toHaveBeenCalled();
  });
});
