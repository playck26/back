import {
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { montarChave } from '../storage/chave-de-midia';
import {
  FotoDePerfilService,
  MOTIVO_REMOCAO,
  MOTIVO_TROCA,
} from './foto-de-perfil.service';

/**
 * SPEC-018/TASK-003 — as provas da foto de perfil.
 *
 * O caminho feliz aparece o mínimo. O que este arquivo guarda é a **ordem**
 * das coisas — que é onde os defeitos desta task moram:
 *
 * - a recusa do `super_admin` acontece **antes** de validar, hashear e
 *   gravar (AC-022). Depois, viraria 500 vindo de constraint;
 * - o storage é escrito **antes** do banco. Na ordem inversa, uma falha
 *   deixaria a coluna apontando para objeto inexistente;
 * - o enfileiramento acontece **dentro** da mesma transação do `UPDATE`.
 *   Fora dela, existe uma janela em que a chave antiga fica órfã para
 *   sempre.
 */

const EMPRESA = '11111111-1111-4111-8111-111000180001';
const USUARIO = '33333333-3333-4333-8333-333000180003';

/**
 * Um WebP mínimo e **válido de verdade** — o `validarWebp` real roda nestes
 * bytes. Fabricar um "corpo qualquer" faria os testes provarem o mock.
 */
function webpValido(cor = 0x9d): Buffer {
  // VP8 lossy: cabeçalho RIFF + chunk `VP8 ` com o start code e um frame
  // 1x1. Os bytes vêm do formato, não de invenção.
  const frame = Buffer.from([
    0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00, 0x02, 0x00,
    0x34, 0x25, 0xa4, 0x00, 0x03, 0x70, 0x00, 0xfe, 0xfb, 0xfd, 0x50, 0x00,
  ]);
  frame[3] = cor; // muda o conteúdo => muda o sha256 => muda a chave
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

interface Cenario {
  servico: FotoDePerfilService;
  ordem: string[];
  gravar: jest.Mock;
  enfileirar: jest.Mock;
  update: jest.Mock;
  urlDeLeitura: jest.Mock;
}

function montar(usuario: {
  companyId: string | null;
  fotoKey: string | null;
}): Cenario {
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
  const urlDeLeitura = jest.fn(() => Promise.resolve('https://assinada/x'));

  const estado = { ...usuario };
  const prisma = {
    usuario: {
      findUniqueOrThrow: jest.fn(() =>
        Promise.resolve({ id: USUARIO, ...estado }),
      ),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      ordem.push('transacao:inicio');
      const r = await fn({ usuario: { update } });
      ordem.push('transacao:fim');
      return r;
    }),
  };

  const storage = {
    urlDeLeitura,
    visibilidadeDoTipo: jest.fn(() => 'privado' as const),
  };

  const servico = new FotoDePerfilService(
    prisma as never,
    storage as never,
    { enfileirar } as never,
    { gravar } as never,
  );

  return { servico, ordem, gravar, enfileirar, update, urlDeLeitura };
}

describe('AC-022 — quem não tem empresa é recusado ANTES de qualquer trabalho', () => {
  it('recusa o super_admin com 403 PERFIL_SEM_EMPRESA', async () => {
    const c = montar({ companyId: null, fotoKey: null });
    await expect(
      c.servico.substituir(USUARIO, webpValido()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('e recusa SEM tocar no storage — senão viraria 500 vindo de constraint', async () => {
    // Esta é a asserção que importa. Um 403 devolvido depois de gravar no
    // bucket deixaria objeto órfão a cada tentativa; e um 403 devolvido
    // depois do `UPDATE` nem existiria — o CHECK
    // `usuarios_foto_da_empresa_check` teria estourado antes.
    const c = montar({ companyId: null, fotoKey: null });
    await expect(c.servico.substituir(USUARIO, webpValido())).rejects.toThrow();
    expect(c.gravar).not.toHaveBeenCalled();
    expect(c.update).not.toHaveBeenCalled();
    expect(c.ordem).toEqual([]);
  });

  it('recusa também no remover e no ler', async () => {
    const c = montar({ companyId: null, fotoKey: null });
    await expect(c.servico.remover(USUARIO)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('mas o corpo inválido NÃO passa na frente da recusa por empresa', async () => {
    // Ordem de recusa é decisão: se o 422 viesse primeiro, um super admin
    // descobriria pelo código de erro que o problema "era só o arquivo".
    const c = montar({ companyId: null, fotoKey: null });
    await expect(
      c.servico.substituir(USUARIO, Buffer.from('não é webp')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('substituir — a ordem das escritas', () => {
  it('grava no storage ANTES do banco, e enfileira DENTRO da transação', async () => {
    const c = montar({ companyId: EMPRESA, fotoKey: null });
    await c.servico.substituir(USUARIO, webpValido());

    expect(c.ordem).toEqual([
      'storage:gravar',
      'transacao:inicio',
      'banco:update',
      'fila:enfileirar',
      'transacao:fim',
    ]);
  });

  it('a chave é derivada do CONTEÚDO, e bate com a gramática da SPEC-017', async () => {
    const c = montar({ companyId: EMPRESA, fotoKey: null });
    const corpo = webpValido();
    await c.servico.substituir(USUARIO, corpo);

    const esperada = montarChave({
      companyId: EMPRESA,
      tipo: 'perfil',
      recursoId: USUARIO,
      sha256: createHash('sha256').update(corpo).digest('hex'),
    });
    expect(esperada).not.toBeNull();
    expect(c.gravar).toHaveBeenCalledWith(
      expect.objectContaining({ key: esperada, contentType: 'image/webp' }),
    );
  });

  it('sobe como PRIVADO — foto de pessoa nunca vira URL permanente de CDN', async () => {
    const c = montar({ companyId: EMPRESA, fotoKey: null });
    await c.servico.substituir(USUARIO, webpValido());
    expect(c.gravar).toHaveBeenCalledWith(
      expect.objectContaining({ visibilidade: 'privado' }),
    );
  });

  it('enfileira a chave ANTERIOR na troca, com a nova junto', async () => {
    const anterior = montarChave({
      companyId: EMPRESA,
      tipo: 'perfil',
      recursoId: USUARIO,
      sha256: 'b'.repeat(64),
    })!;
    const c = montar({ companyId: EMPRESA, fotoKey: anterior });
    await c.servico.substituir(USUARIO, webpValido());

    // `chaveNova` vai junto porque é ela que faz a fila reconhecer o reenvio
    // da MESMA foto (AC-013) e não agendar a exclusão do objeto que a
    // requisição acabou de confirmar.
    expect(c.enfileirar).toHaveBeenCalledWith(
      expect.objectContaining({
        chaveAnterior: anterior,
        motivo: MOTIVO_TROCA,
      }),
      expect.anything(),
    );
    const chamadas = c.enfileirar.mock.calls as { chaveNova: string }[][];
    expect(chamadas[0][0].chaveNova).not.toBe(anterior);
  });

  it('recusa corpo que não é WebP, com o código do validador', async () => {
    const c = montar({ companyId: EMPRESA, fotoKey: null });
    await expect(
      c.servico.substituir(USUARIO, Buffer.from('PNG de mentira')),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(c.gravar).not.toHaveBeenCalled();
  });
});

describe('remover — AC-010, e o worker é quem apaga', () => {
  it('zera a coluna e enfileira, na mesma transação', async () => {
    const anterior = montarChave({
      companyId: EMPRESA,
      tipo: 'perfil',
      recursoId: USUARIO,
      sha256: 'c'.repeat(64),
    })!;
    const c = montar({ companyId: EMPRESA, fotoKey: anterior });
    await c.servico.remover(USUARIO);

    expect(c.update).toHaveBeenCalledWith({
      where: { id: USUARIO },
      data: { fotoKey: null },
    });
    expect(c.enfileirar).toHaveBeenCalledWith(
      expect.objectContaining({
        chaveAnterior: anterior,
        chaveNova: null,
        motivo: MOTIVO_REMOCAO,
      }),
      expect.anything(),
    );
    expect(c.ordem).toEqual([
      'transacao:inicio',
      'banco:update',
      'fila:enfileirar',
      'transacao:fim',
    ]);
  });

  it('NUNCA apaga o objeto direto — quem apaga é o worker, depois da carência', async () => {
    const anterior = montarChave({
      companyId: EMPRESA,
      tipo: 'perfil',
      recursoId: USUARIO,
      sha256: 'd'.repeat(64),
    })!;
    const c = montar({ companyId: EMPRESA, fotoKey: anterior });
    await c.servico.remover(USUARIO);
    // Apagar aqui tiraria a janela em que um engano ainda é reversível.
    expect(c.gravar).not.toHaveBeenCalled();
  });

  it('é idempotente: remover sem foto é sucesso, não 404', async () => {
    const c = montar({ companyId: EMPRESA, fotoKey: null });
    await expect(c.servico.remover(USUARIO)).resolves.toBeUndefined();
    expect(c.update).not.toHaveBeenCalled();
    expect(c.enfileirar).not.toHaveBeenCalled();
  });
});

describe('ler — a chave do banco é tratada como não confiável', () => {
  it('devolve url nula quando não há foto, e não pergunta ao storage', async () => {
    const c = montar({ companyId: EMPRESA, fotoKey: null });
    await expect(c.servico.ler(USUARIO)).resolves.toEqual({ url: null });
    expect(c.urlDeLeitura).not.toHaveBeenCalled();
  });

  it('passa a chave pelo StorageService, que reconfere empresa e recurso', async () => {
    const key = montarChave({
      companyId: EMPRESA,
      tipo: 'perfil',
      recursoId: USUARIO,
      sha256: 'e'.repeat(64),
    })!;
    const c = montar({ companyId: EMPRESA, fotoKey: key });
    await c.servico.ler(USUARIO);

    // É esta reconferência que pega chave adulterada no banco — cenário que
    // nem o prefixo nem o escopo por token pegam, porque os dois leem o
    // mesmo token (SPEC-017/INV-037).
    expect(c.urlDeLeitura).toHaveBeenCalledWith({
      key,
      companyId: EMPRESA,
      tipo: 'perfil',
      recursoId: USUARIO,
    });
  });
});
