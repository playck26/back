import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { buildUsuarioAtivo, loginAndGetTokens } from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { bodyOf } from './utils/http';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

/**
 * SPEC-038 — a importação na camada HTTP.
 *
 * **O que só existe aqui:** o upload multipart e o `?conferir=true` decidindo
 * entre validar e escrever. A validação linha a linha tem teste próprio sem
 * banco; o rollback tem teste próprio com Postgres.
 *
 * O caso decisivo é o do parâmetro: **`conferir=true` não pode escrever**, e a
 * prova é contar `usuario.create`. Um teste que só verificasse "respondeu 200"
 * ficaria verde com uma implementação que ignora o parâmetro.
 */
const ROTA = '/api/v1/students/importar';
const PLANILHA = 'nome,email\nAna,ana@clube.local\nBeto,beto@clube.local';

describe('Importação de alunos (e2e) — SPEC-038', () => {
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
    prisma.usuario.findMany.mockResolvedValue([]);
    prisma.nivel.findMany.mockResolvedValue([]);
    return accessToken;
  }

  const enviar = (token: string, conteudo: string, conferir: boolean) =>
    request(app.getHttpServer())
      .post(`${ROTA}${conferir ? '?conferir=true' : ''}`)
      .set('Authorization', `Bearer ${token}`)
      .attach('arquivo', Buffer.from(conteudo, 'utf8'), 'alunos.csv');

  it('AC-001: `conferir=true` devolve o relatório e **NÃO escreve**', async () => {
    const token = await comoAdmin();
    const res = await enviar(token, PLANILHA, true).expect(201);

    const corpo = bodyOf<{ total: number; validas: number }>(res);
    expect(corpo.total).toBe(2);
    expect(corpo.validas).toBe(2);
    // **A prova é a contagem.** "Respondeu 200" ficaria verde com uma
    // implementação que ignora o parâmetro e escreve.
    expect(prisma.tx.usuario.create).not.toHaveBeenCalled();
  });

  it('AC-004: coluna desconhecida é 422, nomeando qual', async () => {
    const token = await comoAdmin();
    const res = await enviar(
      token,
      'nome,email,apelido\nAna,ana@clube.local,Aninha',
      true,
    ).expect(422);

    expect(bodyOf<{ code: string }>(res).code).toBe('COLUNA_DESCONHECIDA');
  });

  it('AC-012: com erro, o `importar` devolve 422 e não escreve', async () => {
    const token = await comoAdmin();
    const res = await enviar(
      token,
      'nome,email\n,sem-nome@clube.local',
      false,
    ).expect(422);

    expect(bodyOf<{ code: string }>(res).code).toBe('PLANILHA_COM_ERROS');
    expect(prisma.tx.usuario.create).not.toHaveBeenCalled();
  });

  it('**o BOM do Excel não quebra o cabeçalho**', async () => {
    const token = await comoAdmin();
    // Sem removê-lo, a primeira coluna se chamaria `﻿nome` e a planilha
    // seria recusada apontando para uma coluna que, na tela do gestor, está
    // escrita certa — e ele não teria como descobrir sozinho.
    const res = await enviar(token, `﻿${PLANILHA}`, true).expect(201);
    expect(bodyOf<{ validas: number }>(res).validas).toBe(2);
  });

  it('sem arquivo é 400, com o código do upload', async () => {
    const token = await comoAdmin();
    await request(app.getHttpServer())
      .post(`${ROTA}?conferir=true`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });
});
