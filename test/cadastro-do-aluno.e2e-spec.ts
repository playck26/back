import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { buildUsuarioAtivo, loginAndGetTokens } from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { bodyOf } from './utils/http';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

/**
 * SPEC-036 — o cadastro completo na camada HTTP.
 *
 * **O que este arquivo prova, e o que ele não prova.** Aqui o Prisma é
 * mockado: exercita guard, papel, DTO e a recusa da data implausível — o que
 * só existe no HTTP. Que o banco recuse `uf = 'XX'` está em
 * `test/banco/spec-036-cadastro-completo.db-spec.ts`, contra Postgres real,
 * porque mock não tem `CHECK`.
 *
 * **O caso mais importante é o AC-012**, e ele prova uma AUSÊNCIA: aluno com
 * cadastro incompleto continua reservando quadra. Uma spec que introduz a
 * palavra "completude" convida a primeira pessoa que a lê a usá-la como
 * requisito — e este teste é o que fica vermelho no dia em que alguém fizer
 * isso sem decisão.
 */
const ALUNO_ID = '44444444-4444-4444-8444-444444444444';
const ROTA_ME = '/api/v1/me/cadastro';

describe('Cadastro do aluno (e2e) — SPEC-036', () => {
  let app: INestApplication<App>;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    app = await createTestApp(prisma);
  });

  afterEach(async () => {
    await app.close();
  });

  /** A ficha que o `findFirst` devolve, e a que o `update` devolve de volta. */
  function fichaDe(extra: Record<string, unknown> = {}) {
    return {
      id: ALUNO_ID,
      usuarioId: 'u-aluno',
      nivelId: null,
      status: 'ativo',
      dataNascimento: null,
      emergenciaNome: null,
      emergenciaTelefone: null,
      endereco: null,
      cidade: null,
      uf: null,
      observacoesSaude: null,
      usuario: {
        nome: 'Ana',
        email: 'ana@clube.local',
        telefone: null,
      },
      ...extra,
    };
  }

  async function comoAluno() {
    const usuario = await buildUsuarioAtivo({
      id: 'u-aluno',
      email: 'ana@clube.local',
      role: 'aluno',
    });
    const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
    prisma.aluno.findFirst.mockResolvedValue(fichaDe());
    prisma.aluno.update.mockResolvedValue(fichaDe());
    prisma.tx.aluno.update.mockResolvedValue(fichaDe());
    return accessToken;
  }

  async function comoProfessor() {
    const usuario = await buildUsuarioAtivo({
      id: 'u-prof',
      email: 'prof@clube.local',
      role: 'professor',
    });
    const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
    return accessToken;
  }

  it('AC-007: o GET devolve os sete campos e o bloco `cadastro`', async () => {
    const token = await comoAluno();
    const res = await request(app.getHttpServer())
      .get(ROTA_ME)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const corpo = bodyOf<{
      cadastro: { percentual: number; faltam: string[] };
      dataNascimento: string | null;
    }>(res);
    // Nome e e-mail preenchidos, o resto vazio: 2 de 7 = 29%, que é o piso
    // real (AC-011). Zero por cento faria quem acabou de se cadastrar concluir
    // que o cadastro não salvou.
    expect(corpo.cadastro.percentual).toBe(29);
    expect(corpo.cadastro.faltam).toContain('dataNascimento');
    // A chave existe com `null` — ausência de chave é indistinguível de "esta
    // versão do servidor não tem este campo", e a tela não saberia se pede.
    expect(corpo.dataNascimento).toBeNull();
  });

  it('AC-008: professor recebe 403 — ele não tem ficha de aluno', async () => {
    const token = await comoProfessor();
    await request(app.getHttpServer())
      .get(ROTA_ME)
      .set('Authorization', `Bearer ${token}`)
      // Devolver `{}` faria a tela do Cliente renderizar uma barra de 0% para
      // o professor, cobrando que ele complete um cadastro que não existe.
      .expect(403);
  });

  it('AC-006: o PATCH do aluno grava os sete', async () => {
    const token = await comoAluno();
    await request(app.getHttpServer())
      .patch(ROTA_ME)
      .set('Authorization', `Bearer ${token}`)
      .send({
        dataNascimento: '1990-05-10',
        emergenciaNome: 'Beto',
        emergenciaTelefone: '11988887777',
        cidade: 'Santos',
        uf: 'SP',
      })
      .expect(200);

    const [args] = prisma.tx.aluno.update.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(args.data.emergenciaNome).toBe('Beto');
    expect(args.data.uf).toBe('SP');
    // A data vira `Date` em UTC com as partes explícitas — `new Date(iso)` já
    // virou o dia anterior neste projeto mais de uma vez (DEF-020).
    expect((args.data.dataNascimento as Date).toISOString()).toBe(
      '1990-05-10T00:00:00.000Z',
    );
  });

  it('AC-006: `nivelId` e `status` NÃO existem no DTO do aluno (D7)', async () => {
    const token = await comoAluno();
    await request(app.getHttpServer())
      .patch(ROTA_ME)
      .set('Authorization', `Bearer ${token}`)
      .send({ cidade: 'Santos', nivelId: 'n-outro', status: 'inativo' })
      // **`forbidNonWhitelisted` recusa a requisição inteira**, e é o que
      // torna a garantia de TIPO e não de vigilância: não há `if` para
      // alguém esquecer numa rota futura.
      .expect(400);

    expect(prisma.tx.aluno.update).not.toHaveBeenCalled();
  });

  it('AC-004: data no futuro é 422 `DATA_NASCIMENTO_INVALIDA`', async () => {
    const token = await comoAluno();
    const res = await request(app.getHttpServer())
      .patch(ROTA_ME)
      .set('Authorization', `Bearer ${token}`)
      .send({ dataNascimento: '2099-01-01' })
      .expect(422);

    expect(bodyOf<{ code: string }>(res).code).toBe('DATA_NASCIMENTO_INVALIDA');
  });

  it('`2026-02-31` é recusada — e quem pega é o DECORADOR, não o serviço', async () => {
    const token = await comoAluno();
    /**
     * **Eu escrevi que nenhum decorador de formato pegaria isto, e estava
     * errado.** `@IsISO8601({ strict: true })` valida o calendário: 31 de
     * fevereiro é recusado antes de chegar ao serviço, e a resposta é **400**
     * como qualquer falha de `class-validator` neste projeto.
     *
     * A conferência do serviço continua existindo e **não é redundância
     * morta**: a SPEC-038 vai importar aluno por planilha, e naquele caminho
     * o DTO não passa por lugar nenhum. Ela tem teste próprio em
     * `normalizar-nascimento.spec.ts`, que é onde ela é alcançável.
     */
    await request(app.getHttpServer())
      .patch(ROTA_ME)
      .set('Authorization', `Bearer ${token}`)
      .send({ dataNascimento: '2026-02-31' })
      .expect(400);

    expect(prisma.tx.aluno.update).not.toHaveBeenCalled();
  });

  it('AC-003: `uf` fora das 27 é 400 — pelo pipe, não por código próprio', async () => {
    const token = await comoAluno();
    // O projeto decidiu que falha de `class-validator` sai 400
    // (`configurar-app.ts` existe para impedir divergência por rota). Inventar
    // um `UF_INVALIDA` aqui obrigaria a checar na aplicação o que o decorador
    // já checa.
    await request(app.getHttpServer())
      .patch(ROTA_ME)
      .set('Authorization', `Bearer ${token}`)
      .send({ uf: 'XX' })
      .expect(400);
  });

  it('AC-005: string vazia é 400 — `null` é que apaga', async () => {
    const token = await comoAluno();
    await request(app.getHttpServer())
      .patch(ROTA_ME)
      .set('Authorization', `Bearer ${token}`)
      .send({ cidade: '' })
      .expect(400);
  });

  it('`null` apaga, e chega ao Prisma como `null`', async () => {
    const token = await comoAluno();
    await request(app.getHttpServer())
      .patch(ROTA_ME)
      .set('Authorization', `Bearer ${token}`)
      .send({ cidade: null })
      .expect(200);

    const [args] = prisma.tx.aluno.update.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    // `null` e `undefined` são intenções diferentes e o Prisma já as
    // distingue: traduzir uma na outra apagaria dado por engano, ou deixaria
    // de apagar quando a pessoa pediu.
    expect(args.data.cidade).toBeNull();
    expect(args.data.emergenciaNome).toBeUndefined();
  });
});
