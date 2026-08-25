import { NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { montarChave } from '../storage/chave-de-midia';
import {
  LogoDaEmpresaService,
  MOTIVO_REMOCAO_LOGO,
  MOTIVO_TROCA_LOGO,
} from './logo-da-empresa.service';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';

/**
 * SPEC-018/TASK-006 — as provas da logo.
 *
 * **O que muda em relação à TASK-003 é o `:id` na URL.** Em `/me/foto` a
 * AC-004 era estrutural: não existia caminho pelo qual outro id chegasse.
 * Aqui existe, e o escopo é uma decisão de código — que é exatamente o tipo
 * de coisa que este arquivo tem de guardar.
 */

const EMPRESA_A = '11111111-1111-4111-8111-111000180001';
const EMPRESA_B = '22222222-2222-4222-8222-222000180002';
const ADMIN_A = '33333333-3333-4333-8333-333000180003';

const CDN = 'https://cdn.exemplo/';

function webpValido(cor = 0x9d): Buffer {
  const frame = Buffer.from([
    0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00, 0x02, 0x00,
    0x34, 0x25, 0xa4, 0x00, 0x03, 0x70, 0x00, 0xfe, 0xfb, 0xfd, 0x50, 0x00,
  ]);
  frame[3] = cor;
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

const chaveDe = (companyId: string, sha = 'a'.repeat(64)) =>
  montarChave({
    companyId,
    tipo: 'logo',
    recursoId: companyId,
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

function montar(empresa: {
  id?: string;
  logoKey: string | null;
  logoUrl: string | null;
}) {
  const estado = { id: EMPRESA_A, ...empresa };
  const ordem: string[] = [];

  const update = jest.fn(() => {
    ordem.push('banco:update');
    return Promise.resolve({});
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
    empresa: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === estado.id ? estado : null),
      ),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      ordem.push('transacao:inicio');
      const r = await fn({ empresa: { update } });
      ordem.push('transacao:fim');
      return r;
    },
  };

  const servico = new LogoDaEmpresaService(
    prisma as never,
    { visibilidadeDoTipo: () => 'publico' as const } as never,
    { enfileirar } as never,
    { gravar, urlPublica: (key: string) => CDN + key } as never,
  );

  return { servico, ordem, gravar, enfileirar, update };
}

describe('resolver — AC-013, e é por isso que existe UM lugar só', () => {
  it('sem upload, devolve a `logo_url` antiga intacta', () => {
    // A empresa que já tinha URL externa continua exibindo — a spec diz
    // explicitamente que as `logo_url` existentes não migram.
    const { servico } = montar({
      logoKey: null,
      logoUrl: 'https://clube.antigo/logo.png',
    });
    expect(
      servico.resolver({
        id: EMPRESA_A,
        logoKey: null,
        logoUrl: 'https://clube.antigo/logo.png',
      }),
    ).toEqual({
      logoUrl: 'https://clube.antigo/logo.png',
    });
  });

  it('com upload, a chave vira URL de CDN — pública, sem assinatura', () => {
    const { servico } = montar({ logoKey: null, logoUrl: null });
    const key = chaveDe(EMPRESA_A);
    expect(
      servico.resolver({ id: EMPRESA_A, logoKey: key, logoUrl: null }),
    ).toEqual({
      logoUrl: CDN + key,
    });
  });

  it('o upload GANHA da `logo_url` antiga quando os dois existem', () => {
    const { servico } = montar({ logoKey: null, logoUrl: null });
    const key = chaveDe(EMPRESA_A);
    expect(
      servico.resolver({
        id: EMPRESA_A,
        logoKey: key,
        logoUrl: 'https://clube.antigo/logo.png',
      }).logoUrl,
    ).toBe(CDN + key);
  });

  it('sem nada, devolve null — e null é estado normal, não erro', () => {
    const { servico } = montar({ logoKey: null, logoUrl: null });
    expect(
      servico.resolver({ id: EMPRESA_A, logoKey: null, logoUrl: null }),
    ).toEqual({ logoUrl: null });
  });

  it('chave de OUTRA empresa no banco cai para a antiga, e não estoura', () => {
    // Fail-soft de propósito: isto roda no caminho de leitura, inclusive
    // numa listagem. Uma linha corrompida não pode derrubar a página toda.
    const { servico } = montar({ logoKey: null, logoUrl: null });
    expect(
      servico.resolver({
        id: EMPRESA_A,
        logoKey: chaveDe(EMPRESA_B),
        logoUrl: 'https://clube.antigo/logo.png',
      }).logoUrl,
    ).toBe('https://clube.antigo/logo.png');
  });

  it('chave corrompida também cai para a antiga', () => {
    const { servico } = montar({ logoKey: null, logoUrl: null });
    expect(
      servico.resolver({
        id: EMPRESA_A,
        logoKey: 'lixo/que/nao/parseia',
        logoUrl: null,
      }).logoUrl,
    ).toBeNull();
  });

  it('chave de outro TIPO de mídia não vira logo', () => {
    // Uma foto de perfil apontada na coluna de logo viraria imagem privada
    // servida por URL pública permanente.
    const perfil = montarChave({
      companyId: EMPRESA_A,
      tipo: 'perfil',
      recursoId: EMPRESA_A,
      sha256: 'b'.repeat(64),
    })!;
    const { servico } = montar({ logoKey: null, logoUrl: null });
    expect(
      servico.resolver({ id: EMPRESA_A, logoKey: perfil, logoUrl: null })
        .logoUrl,
    ).toBeNull();
  });
});

describe('AC-014 — o escopo, que aqui não é estrutural', () => {
  it('gestor de outra empresa recebe 404, nunca 403', async () => {
    // 403 confirmaria que a empresa existe, e é exatamente a pergunta que o
    // 404 esconde.
    const c = montar({ logoKey: null, logoUrl: null });
    const gestorDeB = {
      ...gestorDeA,
      companyId: EMPRESA_B,
    } as AccessTokenPayload;

    await expect(
      c.servico.substituir(EMPRESA_A, gestorDeB, webpValido()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(c.gravar).not.toHaveBeenCalled();
  });

  it('e a recusa acontece ANTES de validar ou gravar', async () => {
    const c = montar({ logoKey: null, logoUrl: null });
    const gestorDeB = {
      ...gestorDeA,
      companyId: EMPRESA_B,
    } as AccessTokenPayload;
    await expect(
      c.servico.substituir(EMPRESA_A, gestorDeB, webpValido()),
    ).rejects.toThrow();
    expect(c.ordem).toEqual([]);
  });

  it('super_admin alcança qualquer empresa', async () => {
    const c = montar({ logoKey: null, logoUrl: null });
    await expect(
      c.servico.substituir(EMPRESA_A, superAdmin, webpValido()),
    ).resolves.toBeDefined();
    expect(c.gravar).toHaveBeenCalled();
  });

  it('empresa inexistente também é 404, mesmo para o super_admin', async () => {
    const c = montar({ logoKey: null, logoUrl: null });
    await expect(
      c.servico.substituir(EMPRESA_B, superAdmin, webpValido()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('substituir — a ordem, e a chave', () => {
  it('grava no storage antes do banco, e enfileira dentro da transação', async () => {
    const c = montar({ logoKey: null, logoUrl: null });
    await c.servico.substituir(EMPRESA_A, gestorDeA, webpValido());
    expect(c.ordem).toEqual([
      'storage:gravar',
      'transacao:inicio',
      'banco:update',
      'fila:enfileirar',
      'transacao:fim',
    ]);
  });

  it('sobe como PÚBLICO — logo é material corporativo', async () => {
    const c = montar({ logoKey: null, logoUrl: null });
    await c.servico.substituir(EMPRESA_A, gestorDeA, webpValido());
    expect(c.gravar).toHaveBeenCalledWith(
      expect.objectContaining({ visibilidade: 'publico' }),
    );
  });

  it('a chave usa o id da empresa como recurso — uma logo por empresa', async () => {
    const c = montar({ logoKey: null, logoUrl: null });
    const corpo = webpValido();
    await c.servico.substituir(EMPRESA_A, gestorDeA, corpo);
    const sha = createHash('sha256').update(corpo).digest('hex');
    expect(c.gravar).toHaveBeenCalledWith(
      expect.objectContaining({ key: chaveDe(EMPRESA_A, sha) }),
    );
  });

  it('trocar enfileira a logo anterior', async () => {
    const anterior = chaveDe(EMPRESA_A, 'c'.repeat(64));
    const c = montar({ logoKey: anterior, logoUrl: null });
    await c.servico.substituir(EMPRESA_A, gestorDeA, webpValido());
    expect(c.enfileirar).toHaveBeenCalledWith(
      expect.objectContaining({
        chaveAnterior: anterior,
        motivo: MOTIVO_TROCA_LOGO,
      }),
      expect.anything(),
    );
  });

  it('recusa corpo que não é WebP, e nada é gravado', async () => {
    const c = montar({ logoKey: null, logoUrl: null });
    await expect(
      c.servico.substituir(EMPRESA_A, gestorDeA, Buffer.from('PNG falso')),
    ).rejects.toThrow();
    expect(c.gravar).not.toHaveBeenCalled();
  });
});

describe('remover — e a `logo_url` antiga volta a valer', () => {
  it('zera a chave, enfileira, e devolve a URL antiga (AC-013)', async () => {
    // O que torna o `DELETE` diferente do da foto de perfil: aqui remover
    // pode não deixar a tela vazia. Devolver a logo resolvida é o que diz a
    // quem removeu o que vai aparecer agora.
    const anterior = chaveDe(EMPRESA_A, 'd'.repeat(64));
    const c = montar({
      logoKey: anterior,
      logoUrl: 'https://clube.antigo/logo.png',
    });

    const resultado = await c.servico.remover(EMPRESA_A, gestorDeA);

    expect(c.update).toHaveBeenCalledWith({
      where: { id: EMPRESA_A },
      data: { logoKey: null },
    });
    expect(c.enfileirar).toHaveBeenCalledWith(
      expect.objectContaining({
        chaveAnterior: anterior,
        chaveNova: null,
        motivo: MOTIVO_REMOCAO_LOGO,
      }),
      expect.anything(),
    );
    expect(resultado).toEqual({ logoUrl: 'https://clube.antigo/logo.png' });
  });

  it('nunca apaga o objeto direto — quem apaga é o worker', async () => {
    const c = montar({ logoKey: chaveDe(EMPRESA_A), logoUrl: null });
    await c.servico.remover(EMPRESA_A, gestorDeA);
    expect(c.gravar).not.toHaveBeenCalled();
  });

  it('é idempotente: remover sem logo é sucesso', async () => {
    const c = montar({ logoKey: null, logoUrl: null });
    await expect(c.servico.remover(EMPRESA_A, gestorDeA)).resolves.toEqual({
      logoUrl: null,
    });
    expect(c.update).not.toHaveBeenCalled();
  });

  it('gestor de outra empresa não remove nada', async () => {
    const c = montar({ logoKey: chaveDe(EMPRESA_A), logoUrl: null });
    const gestorDeB = {
      ...gestorDeA,
      companyId: EMPRESA_B,
    } as AccessTokenPayload;
    await expect(
      c.servico.remover(EMPRESA_A, gestorDeB),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(c.update).not.toHaveBeenCalled();
  });
});
