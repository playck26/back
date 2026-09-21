import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { buildUsuarioAtivo, loginAndGetTokens } from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

/**
 * **DEF-039 — `/me/classes/anteriores` entrava na rota `:id` e respondia 400.**
 *
 * ## O comentário do arquivo descrevia o defeito que o arquivo tinha
 *
 * `me-classes.controller.ts`, acima de `@Get(':id')`:
 *
 * > *"Declarada DEPOIS de `disponiveis` e `anteriores`: rota com segmento fixo
 * > tem de vir antes da que casa `:id`, senão `/me/classes/anteriores` entra
 * > aqui com `id = "anteriores"` e o pipe de UUID responde 400 para uma rota
 * > que existe."*
 *
 * E a ordem real era:
 *
 * ```
 * 101  @Get()
 * 122  @Get('disponiveis')
 * 164  @Get(':id')          <- o paramétrico
 * 178  @Get('anteriores')   <- o literal, DEPOIS
 * ```
 *
 * O Nest registra na ordem de declaração e o Express casa a primeira. A tela
 * *"Aulas que já passaram"* — o único lugar do produto onde o aluno avalia uma
 * aula — batia em `:id` e levava `400`.
 *
 * **Ninguém pegou porque não havia teste da rota.** Foi encontrado ao planejar
 * a SPEC-066, que acrescenta outra rota literal (`proximas`) no mesmo
 * controller e por isso foi ler a ordem.
 *
 * ## O que este arquivo julga
 *
 * Que a rota **existe** e não é engolida pelo `:id`. Ele não julga o conteúdo
 * da resposta — isso é da SPEC-046 e já tem prova própria.
 */
const ROTA = '/api/v1/me/classes/anteriores';

describe('DEF-039 — a rota `anteriores` não pode cair no `:id`', () => {
  let app: INestApplication<App>;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    app = await createTestApp(prisma);
  });

  afterEach(async () => {
    await app.close();
  });

  async function comoAluno() {
    const aluno = await buildUsuarioAtivo({
      id: 'u-aluno',
      email: 'aluno@empresa.demo',
      role: 'aluno',
    });
    const { accessToken } = await loginAndGetTokens(app, prisma, aluno);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
    return accessToken;
  }

  it('responde à rota literal, e NÃO com 400 de UUID inválido', async () => {
    const token = await comoAluno();

    const res = await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${token}`);

    // **O 400 é o defeito.** Ele significa que o pipe de UUID recebeu a
    // palavra "anteriores" — ou seja, o `:id` engoliu a rota literal.
    expect(res.status).not.toBe(400);
  });
});
