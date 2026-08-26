import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { montarChave } from '../storage/chave-de-midia';
import {
  FotoDeProfessorService,
  MOTIVO_REMOCAO_FOTO,
  MOTIVO_TROCA_FOTO,
} from './foto-de-professor.service';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';

/**
 * SPEC-018/TASK-004 — as provas da foto de professor.
 *
 * **O que este arquivo guarda, e nenhum outro guardava, é a INV-034.** Um
 * professor pode ter as **duas** colunas preenchidas — e não por acidente:
 * é o fluxo normal do produto (ficha sem conta → foto do gestor →
 * `POST /teachers/:id/acesso` cria o login depois). A partir dali a
 * precedência decide o que aparece, e ela é fácil de inverter sem que nada
 * mais quebre.
 *
 * O teste que importa é justamente esse, e ele **não existia em lugar
 * nenhum** antes desta task.
 */

const EMPRESA_A = '11111111-1111-4111-8111-111000180021';
const EMPRESA_B = '22222222-2222-4222-8222-222000180022';
const ADMIN_A = '33333333-3333-4333-8333-333000180023';
const PROFESSOR = '55555555-5555-4555-8555-555000180025';
const USUARIO_DO_PROFESSOR = '66666666-6666-4666-8666-666000180026';

/**
 * O menor VP8 válido que o validador aceita. Sem parâmetro de "cor":
 * `frame[3]` faz parte do start code (`9d 01 2a`), e mexer nele produz um
 * arquivo que o próprio validador recusa.
 */
function webpValido(): Buffer {
  const frame = Buffer.from([
    0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00, 0x02, 0x00,
    0x34, 0x25, 0xa4, 0x00, 0x03, 0x70, 0x00, 0xfe, 0xfb, 0xfd, 0x50, 0x00,
  ]);
  const chunk = Buffer.alloc(8 + frame.length);
  chunk.write('VP8 ', 0, 'ascii');
  chunk.writeUInt32LE(frame.length, 4);
  frame.copy(chunk, 8);
  const riff = Buffer.alloc(12 + chunk.length);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + chunk.length, 4);
  riff.write('WEBP', 8, 'ascii');
  chunk.copy(riff, 12);
  return riff;
}

const chaveDaFicha = (companyId = EMPRESA_A, sha = 'a'.repeat(64)) =>
  montarChave({
    companyId,
    tipo: 'professor',
    recursoId: PROFESSOR,
    sha256: sha,
  })!;

const chaveDoPerfil = (companyId = EMPRESA_A, sha = 'b'.repeat(64)) =>
  montarChave({
    companyId,
    tipo: 'perfil',
    recursoId: USUARIO_DO_PROFESSOR,
    sha256: sha,
  })!;

const gestorDeA: AccessTokenPayload = {
  sub: ADMIN_A,
  role: 'company_admin',
  companyId: EMPRESA_A,
} as AccessTokenPayload;

const superAdmin: AccessTokenPayload = {
  sub: 'super',
  role: 'super_admin',
  companyId: null,
} as AccessTokenPayload;

function montar(professor: {
  fotoKey: string | null;
  usuarioId?: string | null;
  fotoDoUsuario?: string | null;
  companyId?: string;
}) {
  const estado = {
    id: PROFESSOR,
    companyId: EMPRESA_A,
    usuarioId: null as string | null,
    ...professor,
  };
  const ordem: string[] = [];

  const update = jest.fn((args: { data: Record<string, unknown> }) => {
    ordem.push('banco:update');
    return Promise.resolve(args);
  });
  const enfileirar = jest.fn(() => {
    ordem.push('fila:enfileirar');
    return Promise.resolve('enfileirada');
  });
  const gravar = jest.fn(() => {
    ordem.push('storage:gravar');
    return Promise.resolve();
  });

  const prisma = {
    professor: {
      findFirst: jest.fn(
        ({ where }: { where: { id: string; companyId: string } }) =>
          Promise.resolve(
            where.id === estado.id && where.companyId === estado.companyId
              ? {
                  id: estado.id,
                  companyId: estado.companyId,
                  usuarioId: estado.usuarioId,
                  fotoKey: estado.fotoKey,
                  usuario:
                    estado.usuarioId === null
                      ? null
                      : { fotoKey: professor.fotoDoUsuario ?? null },
                }
              : null,
          ),
      ),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      ordem.push('transacao:inicio');
      const r = await fn({ professor: { update } });
      ordem.push('transacao:fim');
      return r;
    },
  };

  // O dublê do `StorageService` responde com uma URL que **carrega o pedido
  // dentro dela**: é assim que os testes da INV-034 provam não só que veio
  // URL, mas que veio a URL do lado certo, com o `recursoId` certo.
  const urlDeLeitura = jest.fn(
    (pedido: { key: string; tipo: string; recursoId: string }) =>
      Promise.resolve(
        `https://assinada/${pedido.tipo}/${pedido.recursoId}?k=${pedido.key}`,
      ),
  );

  const servico = new FotoDeProfessorService(
    prisma as never,
    {
      urlDeLeitura,
      visibilidadeDoTipo: () => 'privado' as const,
    } as never,
    { enfileirar } as never,
    { gravar } as never,
  );

  return { servico, ordem, gravar, enfileirar, update, urlDeLeitura };
}

describe('INV-034 — a precedência, que é de LEITURA e não de escrita', () => {
  it('sem conta: exibe a foto da FICHA', async () => {
    // O caso que motiva a task inteira. `professores.usuario_id` é nulável,
    // e a foto de quem não tem conta não teria onde morar.
    const { servico } = montar({ fotoKey: chaveDaFicha() });

    const r = await servico.resolver({
      id: PROFESSOR,
      companyId: EMPRESA_A,
      usuarioId: null,
      fotoKey: chaveDaFicha(),
      fotoDoUsuario: null,
    });

    expect(r.fotoUrl).toContain('/professor/' + PROFESSOR);
  });

  it('AS DUAS preenchidas: a da CONTA ganha (AC-006)', async () => {
    // **Este é o teste que não existia em lugar nenhum.** E o estado que ele
    // descreve não é anomalia: o professor entra sem conta, o gestor põe a
    // foto, e `POST /teachers/:id/acesso` cria o login depois. As duas
    // colunas ficam preenchidas, e quem tem conta manda na própria imagem.
    const { servico } = montar({ fotoKey: chaveDaFicha() });

    const r = await servico.resolver({
      id: PROFESSOR,
      companyId: EMPRESA_A,
      usuarioId: USUARIO_DO_PROFESSOR,
      fotoKey: chaveDaFicha(),
      fotoDoUsuario: chaveDoPerfil(),
    });

    // Não basta "veio uma URL": tem de ser a do lado do usuário, montada com
    // o `recursoId` do usuário e o tipo `perfil`. Inverter a precedência
    // devolveria uma URL igualmente válida, e um `toBeTruthy` passaria.
    expect(r.fotoUrl).toContain('/perfil/' + USUARIO_DO_PROFESSOR);
    expect(r.fotoUrl).not.toContain('/professor/');
  });

  it('com conta mas SEM foto própria: exibe a da ficha', async () => {
    // O caso comum, e o que justifica a rota aceitar professor com conta: a
    // maioria tem login e nunca mexeu no perfil. Se a precedência tratasse
    // "tem conta" como "não mostra a ficha", a foto do gestor sumiria da
    // tela para quase todo mundo.
    const { servico } = montar({ fotoKey: chaveDaFicha() });

    const r = await servico.resolver({
      id: PROFESSOR,
      companyId: EMPRESA_A,
      usuarioId: USUARIO_DO_PROFESSOR,
      fotoKey: chaveDaFicha(),
      fotoDoUsuario: null,
    });

    expect(r.fotoUrl).toContain('/professor/' + PROFESSOR);
  });

  it('nenhuma das duas: null, e não é erro', async () => {
    const { servico } = montar({ fotoKey: null });
    await expect(
      servico.resolver({
        id: PROFESSOR,
        companyId: EMPRESA_A,
        usuarioId: null,
        fotoKey: null,
        fotoDoUsuario: null,
      }),
    ).resolves.toEqual({ fotoUrl: null });
  });

  it('é FAIL-SOFT: chave que não confere vira null, não exceção', async () => {
    // `urlDeLeitura` lança 404 em chave inválida — certo numa rota de um
    // objeto só, errado numa listagem: uma linha corrompida derrubaria a
    // página inteira de professores.
    const { servico, urlDeLeitura } = montar({ fotoKey: null });
    urlDeLeitura.mockRejectedValue(new NotFoundException());

    await expect(
      servico.resolver({
        id: PROFESSOR,
        companyId: EMPRESA_A,
        usuarioId: null,
        fotoKey: 'lixo/que/nao/e/chave',
        fotoDoUsuario: null,
      }),
    ).resolves.toEqual({ fotoUrl: null });
  });
});

describe('substituir — sempre na ficha, nunca no perfil', () => {
  it('grava em professores.foto_key quando NÃO há conta (AC-005)', async () => {
    const { servico, update, gravar } = montar({ fotoKey: null });

    await servico.substituir(PROFESSOR, gestorDeA, webpValido());

    const dados = update.mock.calls[0][0].data;
    expect(dados).toHaveProperty('fotoKey');
    expect(dados.fotoKey).toEqual(expect.stringContaining('/professor/'));
    expect(gravar).toHaveBeenCalled();
  });

  it('ACEITA professor COM conta, e grava na ficha — nunca em usuarios', async () => {
    // Decisão de 2026-08-26. Recusar criaria uma assimetria difícil de
    // explicar: o mesmo professor aceitaria a foto cinco minutos antes de
    // ganhar o acesso e a recusaria cinco minutos depois.
    //
    // E o que se grava continua sendo a FICHA. `usuarios.foto_key` é da
    // pessoa — escrever lá seria o gestor trocando a imagem de alguém.
    const { servico, update } = montar({
      fotoKey: null,
      usuarioId: USUARIO_DO_PROFESSOR,
      fotoDoUsuario: null,
    });

    await servico.substituir(PROFESSOR, gestorDeA, webpValido());

    const dados = update.mock.calls[0][0].data;
    expect(dados.fotoKey).toEqual(expect.stringContaining('/professor/'));
    expect(dados).not.toHaveProperty('usuario');
    // A chave é do PROFESSOR, não do usuário: o `recursoId` é o id da ficha.
    expect(dados.fotoKey).toEqual(expect.stringContaining(PROFESSOR));
    expect(dados.fotoKey).not.toEqual(
      expect.stringContaining(USUARIO_DO_PROFESSOR),
    );
  });

  it('a resposta obedece à INV-034: com foto própria, a subida some da tela', async () => {
    // O gestor sobe, e a resposta já mostra a foto da pessoa — não a que ele
    // acabou de mandar. É o comportamento certo, e é o que a tela precisa
    // saber para não mentir que a troca "funcionou visualmente".
    const { servico } = montar({
      fotoKey: null,
      usuarioId: USUARIO_DO_PROFESSOR,
      fotoDoUsuario: chaveDoPerfil(),
    });

    const r = await servico.substituir(PROFESSOR, gestorDeA, webpValido());

    expect(r.fotoUrl).toContain('/perfil/' + USUARIO_DO_PROFESSOR);
  });

  it('storage primeiro, banco depois', async () => {
    const { servico, ordem } = montar({ fotoKey: null });
    await servico.substituir(PROFESSOR, gestorDeA, webpValido());
    expect(ordem).toEqual([
      'storage:gravar',
      'transacao:inicio',
      'banco:update',
      'fila:enfileirar',
      'transacao:fim',
    ]);
  });

  it('a chave antiga vai para a fila na troca', async () => {
    const anterior = chaveDaFicha(EMPRESA_A, 'c'.repeat(64));
    const { servico, enfileirar } = montar({ fotoKey: anterior });

    await servico.substituir(PROFESSOR, gestorDeA, webpValido());

    expect(enfileirar).toHaveBeenCalledWith(
      expect.objectContaining({
        chaveAnterior: anterior,
        motivo: MOTIVO_TROCA_FOTO,
      }),
      expect.anything(),
    );
  });

  it('arquivo que não é WebP: 422, e nada vai para o bucket', async () => {
    const { servico, gravar } = montar({ fotoKey: null });
    await expect(
      servico.substituir(PROFESSOR, gestorDeA, Buffer.from('PDF disfarçado')),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(gravar).not.toHaveBeenCalled();
  });
});

describe('escopo — AC-014, e aqui o 404 pesa mais', () => {
  it('professor de outra empresa: 404, nunca 403', async () => {
    // 403 confirmaria que a pessoa trabalha naquele clube.
    const { servico, gravar } = montar({
      fotoKey: null,
      companyId: EMPRESA_B,
    });
    await expect(
      servico.substituir(PROFESSOR, gestorDeA, webpValido()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(gravar).not.toHaveBeenCalled();
  });

  it('LIM-005 — `super_admin` não alcança: não tem empresa', async () => {
    const { servico, gravar } = montar({ fotoKey: null });
    await expect(
      servico.substituir(PROFESSOR, superAdmin, webpValido()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(gravar).not.toHaveBeenCalled();
  });
});

describe('remover — AC-010', () => {
  it('apaga a ficha e enfileira a chave', async () => {
    const key = chaveDaFicha();
    const { servico, update, enfileirar } = montar({ fotoKey: key });

    await servico.remover(PROFESSOR, gestorDeA);

    expect(update.mock.calls[0][0].data).toEqual({ fotoKey: null });
    expect(enfileirar).toHaveBeenCalledWith(
      expect.objectContaining({
        chaveAnterior: key,
        chaveNova: null,
        motivo: MOTIVO_REMOCAO_FOTO,
      }),
      expect.anything(),
    );
  });

  it('NÃO deixa a tela vazia quando a pessoa tem foto própria', async () => {
    // O gestor não tem como apagar a imagem de perfil de ninguém por esta
    // rota. Remover a da ficha revela a da conta, e a resposta diz isso —
    // por isso o `DELETE` devolve a foto resolvida em vez de 204.
    const { servico } = montar({
      fotoKey: chaveDaFicha(),
      usuarioId: USUARIO_DO_PROFESSOR,
      fotoDoUsuario: chaveDoPerfil(),
    });

    const r = await servico.remover(PROFESSOR, gestorDeA);

    expect(r.fotoUrl).toContain('/perfil/' + USUARIO_DO_PROFESSOR);
  });

  it('remover o que não existe é sucesso, e não mexe em nada', async () => {
    const { servico, update, enfileirar } = montar({ fotoKey: null });

    await expect(servico.remover(PROFESSOR, gestorDeA)).resolves.toEqual({
      fotoUrl: null,
    });
    expect(update).not.toHaveBeenCalled();
    expect(enfileirar).not.toHaveBeenCalled();
  });

  it('professor de outra empresa: 404 também no DELETE', async () => {
    const { servico } = montar({ fotoKey: null, companyId: EMPRESA_B });
    await expect(servico.remover(PROFESSOR, gestorDeA)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
