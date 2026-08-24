import {
  BadRequestException,
  ExecutionContext,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  CAMPO_DO_ARQUIVO,
  ErroDeUploadFilter,
  exigirArquivo,
  opcoesDeUpload,
  TamanhoDeCorpoGuard,
  TAMANHO_MAXIMO_BYTES,
} from './upload-de-midia';

// SPEC-017/TASK-002b — a fonte única (INV-048). O comportamento pela rota é
// provado em `test/storage-upload.e2e-spec.ts`; aqui ficam as peças isoladas.

function contextoCom(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

describe('TamanhoDeCorpoGuard — o portão do Content-Length', () => {
  const guard = new TamanhoDeCorpoGuard();

  it('deixa passar corpo dentro do teto', () => {
    expect(guard.canActivate(contextoCom({ 'content-length': '1024' }))).toBe(
      true,
    );
  });

  it('deixa passar exatamente o teto', () => {
    expect(
      guard.canActivate(
        contextoCom({ 'content-length': String(TAMANHO_MAXIMO_BYTES) }),
      ),
    ).toBe(true);
  });

  it('recusa um byte acima do teto', () => {
    expect(() =>
      guard.canActivate(
        contextoCom({ 'content-length': String(TAMANHO_MAXIMO_BYTES + 1) }),
      ),
    ).toThrow(PayloadTooLargeException);
  });

  it('DEIXA PASSAR quando não há Content-Length — chunked é do outro portão', () => {
    // Recusar aqui seria recusar todo corpo em `chunked`, inclusive o
    // legítimo. Quem cuida desse caso é o `limits.fileSize` do Multer,
    // durante o streaming. São dois cenários, e nenhum portão cobre o outro.
    expect(guard.canActivate(contextoCom({}))).toBe(true);
    expect(guard.canActivate(contextoCom({ 'content-length': 'abc' }))).toBe(
      true,
    );
  });
});

describe('ErroDeUploadFilter — o `code` estável', () => {
  function responder(erro: PayloadTooLargeException | BadRequestException) {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as never;
    new ErroDeUploadFilter().catch(erro, host);
    return { status, json };
  }

  it('413 vira CORPO_GRANDE_DEMAIS', () => {
    const { status, json } = responder(new PayloadTooLargeException());
    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'CORPO_GRANDE_DEMAIS' }),
    );
  });

  it('400 vira CAMPO_INESPERADO', () => {
    const { status, json } = responder(new BadRequestException());
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'CAMPO_INESPERADO' }),
    );
  });
});

describe('opcoesDeUpload — os limites de que o NFR-001 depende', () => {
  it('limita tamanho, quantidade e partes', () => {
    const opcoes = opcoesDeUpload();
    expect(opcoes.limits.fileSize).toBe(TAMANHO_MAXIMO_BYTES);
    expect(opcoes.limits.files).toBe(1);
    expect(opcoes.limits.parts).toBeLessThanOrEqual(3);
  });

  it('não configura storage: o default do Multer é memória', () => {
    // Disco criaria um estado intermediário que ninguém limpa quando a
    // validação recusa, e a AC-006 exige "nada gravado".
    expect(opcoesDeUpload()).not.toHaveProperty('storage');
  });

  it('o campo é `arquivo`, e o contrato inteiro depende disso', () => {
    expect(CAMPO_DO_ARQUIVO).toBe('arquivo');
  });
});

describe('exigirArquivo', () => {
  it('devolve o buffer quando o arquivo veio', () => {
    const corpo = Buffer.from('x');
    expect(exigirArquivo({ buffer: corpo } as Express.Multer.File)).toBe(corpo);
  });

  it.each([[undefined], [{} as Express.Multer.File]])(
    'recusa ausência (%p) com o mesmo código de campo errado',
    (arquivo) => {
      // Para quem chama, "mandou no campo errado" e "não mandou" são o mesmo
      // defeito, e merecem a mesma instrução de correção.
      expect(() => exigirArquivo(arquivo)).toThrow(BadRequestException);
    },
  );
});
