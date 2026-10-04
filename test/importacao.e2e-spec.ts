import { Logger, type INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { MemoriaProvedorDeEmail } from '../src/email/memoria-provedor-de-email';
import { PROVEDOR_DE_EMAIL } from '../src/email/provedor-de-email';
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
 * prova é contar a transação. Um teste que só verificasse "respondeu 200"
 * ficaria verde com uma implementação que ignora o parâmetro.
 *
 * **SPEC-083/D5 — o campo `convidar` do multipart** também só existe aqui: é a
 * camada HTTP que o entrega ao serviço, e um controller que o perdesse
 * deixaria todas as linhas com senha, sem erro nenhum. O e-mail sai pelo
 * provedor **memória** do app de verdade (o `EmailModule`), que é de onde o
 * teste lê o que foi enviado.
 */

// Antes de o app subir: o `EmailModule` lê no boot. Nenhum e-mail sai daqui,
// mesmo com um `.env` que diga outra coisa.
process.env.EMAIL_PROVEDOR = 'memoria';
process.env.EMAIL_REMETENTE = 'convites@remetente.e2e.local';
process.env.EMAIL_RESPONDER_PARA = 'respostas@suporte.e2e.local';
process.env.URL_CLIENTE = 'https://cliente.e2e.local';

const ROTA = '/api/v1/students/importar';
const PLANILHA = 'nome,email\nAna,ana@clube.local\nBeto,beto@clube.local';

/** Uma instrução crua que a transação mandou, já montada. */
interface Instrucao {
  sql: string;
  valores: unknown[];
}

describe('Importação de alunos (e2e) — SPEC-038', () => {
  let app: INestApplication<App>;
  let prisma: PrismaMock;
  let memoria: MemoriaProvedorDeEmail;
  let instrucoes: Instrucao[];
  let conviteDeAcesso: { updateMany: jest.Mock };

  beforeEach(async () => {
    prisma = buildPrismaMock();
    // O resultado do envio é gravado depois do commit (D8); o dublê geral não
    // tem a tabela nova.
    conviteDeAcesso = { updateMany: jest.fn().mockResolvedValue({ count: 1 }) };
    Object.assign(prisma, { conviteDeAcesso });
    app = await createTestApp(prisma);
    const provedor = app.get<unknown>(PROVEDOR_DE_EMAIL);
    // A precondição de tudo o que se lê do e-mail: é o provedor memória.
    expect(provedor).toBeInstanceOf(MemoriaProvedorDeEmail);
    memoria = provedor as MemoriaProvedorDeEmail;
    memoria.limpar();
    instrucoes = [];
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  /**
   * As instruções da transação da importação (SPEC-083/D3): a trava, as
   * linhas referenciadas, os ajustes do prazo e as escritas em lote, todas
   * cruas. O dublê responde o que cada uma devolveria e guarda o texto.
   */
  function armarTransacaoDaImportacao() {
    const montar = (primeiro: unknown, resto: unknown[]): Instrucao => {
      const sql = Array.isArray(primeiro)
        ? Prisma.sql(primeiro as readonly string[], ...(resto as Prisma.Sql[]))
        : (primeiro as Prisma.Sql);
      const i = { sql: sql.sql, valores: sql.values };
      instrucoes.push(i);
      return i;
    };
    const arranjos = (i: Instrucao) =>
      i.valores.filter((v): v is string[] => Array.isArray(v));
    prisma.tx.$queryRaw.mockImplementation(
      (primeiro: unknown, ...resto: unknown[]) => {
        const i = montar(primeiro, resto);
        if (i.sql.includes('FROM empresas e2')) {
          const [tabelas, ids] = arranjos(i);
          return Promise.resolve(
            tabelas.map((tabela, k) => ({
              tabela,
              achado: ids[k],
              empresa_nome: 'Clube E2E',
            })),
          );
        }
        if (i.sql.includes('INSERT INTO alunos')) {
          return Promise.resolve(arranjos(i)[0].map((id) => ({ id })));
        }
        return Promise.resolve([{ ok: 1 }]);
      },
    );
    prisma.tx.$executeRaw.mockImplementation(
      (primeiro: unknown, ...resto: unknown[]) =>
        Promise.resolve(arranjos(montar(primeiro, resto))[0]?.length ?? 0),
    );
  }

  const escritaDe = (tabela: string) =>
    instrucoes.find((i) => i.sql.includes(`INSERT INTO ${tabela} `));

  async function comoAdmin() {
    const usuario = await buildUsuarioAtivo();
    const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
    prisma.usuario.findMany.mockResolvedValue([]);
    prisma.nivel.findMany.mockResolvedValue([]);
    armarTransacaoDaImportacao();
    return accessToken;
  }

  const enviar = (
    token: string,
    conteudo: string,
    conferir: boolean,
    convidar?: string,
  ) => {
    const r = request(app.getHttpServer())
      .post(`${ROTA}${conferir ? '?conferir=true' : ''}`)
      .set('Authorization', `Bearer ${token}`);
    if (convidar !== undefined) r.field('convidar', convidar);
    return r.attach('arquivo', Buffer.from(conteudo, 'utf8'), 'alunos.csv');
  };

  interface Criado {
    linha: number;
    alunoId: string;
    email: string;
    senhaTemporaria?: string;
    convite?: { email: 'enviado' | 'falhou'; motivo?: string };
  }

  it('AC-001: `conferir=true` devolve o relatório e **NÃO escreve**', async () => {
    const token = await comoAdmin();
    const res = await enviar(token, PLANILHA, true).expect(201);

    const corpo = bodyOf<{ total: number; validas: number }>(res);
    expect(corpo.total).toBe(2);
    expect(corpo.validas).toBe(2);
    // **A prova é a contagem.** "Respondeu 200" ficaria verde com uma
    // implementação que ignora o parâmetro e escreve. Desde a SPEC-083 a
    // escrita é SQL cru dentro da transação: nem transação, nem instrução.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(instrucoes).toEqual([]);
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
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('**o BOM do Excel não quebra o cabeçalho**', async () => {
    const token = await comoAdmin();
    // Sem removê-lo, a primeira coluna se chamaria `\uFEFFnome` e a planilha
    // seria recusada apontando para uma coluna que, na tela do gestor, está
    // escrita certa — e ele não teria como descobrir sozinho.
    const res = await enviar(token, `\uFEFF${PLANILHA}`, true).expect(201);
    expect(bodyOf<{ validas: number }>(res).validas).toBe(2);
  });

  it('sem arquivo é 400, com o código do upload', async () => {
    const token = await comoAdmin();
    await request(app.getHttpServer())
      .post(`${ROTA}?conferir=true`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  describe('SPEC-083/D5 — o campo `convidar` do multipart (REQ-004)', () => {
    const DEZ = [
      'nome;email',
      ...Array.from(
        { length: 10 },
        (_, i) => `Pessoa ${i + 2};pessoa${i + 2}@clube.local`,
      ),
    ].join('\r\n');

    it('AC-017: com convidar=3,5, só as linhas 3 e 5 ganham convite e e-mail; as outras, senha como hoje', async () => {
      const token = await comoAdmin();
      const res = await enviar(token, DEZ, false, '3,5').expect(201);
      const { criados } = bodyOf<{ criados: Criado[] }>(res);

      expect(criados.filter((c) => c.convite).map((c) => c.linha)).toEqual([
        3, 5,
      ]);
      expect(
        criados.filter((c) => c.senhaTemporaria).map((c) => c.linha),
      ).toEqual([2, 4, 6, 7, 8, 9, 10, 11]);
      // AC-018: a convidada não tem senha na resposta — nem o campo.
      for (const c of criados.filter((x) => x.convite)) {
        expect(c).not.toHaveProperty('senhaTemporaria');
        expect(c.convite).toEqual({ email: 'enviado' });
      }
      // Os e-mails saíram para elas e só para elas, numa chamada (AC-032).
      expect(memoria.enviados.map((m) => m.to)).toEqual([
        'pessoa3@clube.local',
        'pessoa5@clube.local',
      ]);
      expect(memoria.blocos).toHaveLength(1);
      // E os convites gravados são das contas das linhas 3 e 5.
      const usuarios = escritaDe('usuarios') as Instrucao;
      const convites = escritaDe('convites_de_acesso') as Instrucao;
      const [idsDosUsuarios, emails] = usuarios.valores.filter(
        (v): v is string[] => Array.isArray(v),
      );
      const donos = convites.valores.filter((v): v is string[] =>
        Array.isArray(v),
      )[1];
      expect(donos.map((id) => emails[idsDosUsuarios.indexOf(id)])).toEqual([
        'pessoa3@clube.local',
        'pessoa5@clube.local',
      ]);
    });

    it('AC-017: convidar=99 num arquivo de 10 linhas → 400 CONVIDAR_LINHA_INVALIDA, e nada é escrito', async () => {
      const token = await comoAdmin();
      const res = await enviar(token, DEZ, false, '99').expect(400);
      expect(bodyOf<{ code: string }>(res).code).toBe(
        'CONVIDAR_LINHA_INVALIDA',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(instrucoes).toEqual([]);
      expect(memoria.blocos).toEqual([]);
    });

    it('sem o campo, ninguém é convidado: a resposta é a de antes da SPEC-083', async () => {
      const token = await comoAdmin();
      const res = await enviar(token, PLANILHA, false).expect(201);
      const { criados } = bodyOf<{ criados: Criado[] }>(res);
      expect(criados.map((c) => [c.linha, typeof c.senhaTemporaria])).toEqual([
        [2, 'string'],
        [3, 'string'],
      ]);
      expect(criados.every((c) => c.convite === undefined)).toBe(true);
      expect(escritaDe('convites_de_acesso')).toBeUndefined();
      expect(memoria.blocos).toEqual([]);
    });

    /**
     * AC-019 e AC-026 — o provedor falhando não derruba a importação; a linha
     * diz `falhou` e o motivo, para o Admin mostrar o caminho. E AC-031, na
     * metade da importação: com o `Logger` capturado, nenhum texto de log
     * contém o token, o link com ele, ou a senha temporária da outra linha.
     */
    it('AC-019: provedor falhando com `cota` → 201, a linha convidada diz `falhou` e o motivo; e nenhum log traz token, link ou senha (AC-031)', async () => {
      const token = await comoAdmin();
      const registrado: string[] = [];
      for (const nivel of [
        'log',
        'warn',
        'error',
        'debug',
        'verbose',
      ] as const) {
        jest
          .spyOn(Logger.prototype, nivel)
          .mockImplementation((...args: unknown[]) => {
            registrado.push(JSON.stringify(args));
          });
        jest.spyOn(Logger, nivel).mockImplementation((...args: unknown[]) => {
          registrado.push(JSON.stringify(args));
        });
      }
      memoria.falharCom('cota');

      const res = await enviar(token, PLANILHA, false, '3').expect(201);
      const { criados } = bodyOf<{ criados: Criado[] }>(res);
      expect(criados[1].convite).toEqual({ email: 'falhou', motivo: 'cota' });
      expect(conviteDeAcesso.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [expect.any(String)] } },
        data: {
          emailResultado: 'falhou',
          emailMotivo: 'cota',
          emailEm: expect.any(Date) as unknown,
        },
      });

      // O token cru existe na mensagem que o provedor recebeu (o memória
      // registra o bloco mesmo falhando) — e em nenhum log.
      const texto = memoria.blocos[0][0].text;
      const link =
        /https:\/\/cliente\.e2e\.local\/ativar\/([A-Za-z0-9_-]{43})/.exec(
          texto,
        );
      expect(link).not.toBeNull();
      const [linkInteiro, tokenCru] = link as RegExpExecArray;
      const senha = criados[0].senhaTemporaria as string;
      expect(senha).toMatch(/^pck-/);
      // A captura pegou algo: o aviso do envio que falhou.
      expect(
        registrado.some((r) => r.includes('convite_de_acesso_nao_enviado')),
      ).toBe(true);
      for (const segredo of [tokenCru, linkInteiro, senha]) {
        expect(registrado.filter((r) => r.includes(segredo))).toEqual([]);
      }
    });
  });
});
