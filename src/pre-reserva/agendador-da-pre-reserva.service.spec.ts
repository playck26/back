import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  AgendadorDaPreReserva,
  INTERVALO_DA_PRE_RESERVA_MS,
} from './agendador-da-pre-reserva.service';
import {
  LOTE_DA_PRE_RESERVA,
  SeletorDoLote,
  loteDaConfiguracao,
} from './seletor-do-lote';
import type { VarredorDaPreReservaService } from './varredor-da-pre-reserva.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * SPEC-074/AC-022 — **o interruptor e o lote.**
 *
 * O `ConfigService` é um dublê porque o que está em julgamento é a LEITURA da
 * configuração, e não o módulo de configuração do Nest.
 */
function config(valores: Record<string, string | undefined>): ConfigService {
  return {
    get: (chave: string) => valores[chave],
  } as unknown as ConfigService;
}

describe('SPEC-074/AC-022 — o sexto agendador', () => {
  const varredor = {
    executarCiclo: jest.fn().mockResolvedValue({}),
  } as unknown as VarredorDaPreReservaService;
  let setIntervalSpy: jest.SpyInstance;
  let setImmediateSpy: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(() => {
    setIntervalSpy = jest
      .spyOn(global, 'setInterval')
      .mockReturnValue({ unref: jest.fn() } as unknown as NodeJS.Timeout);
    setImmediateSpy = jest
      .spyOn(global, 'setImmediate')
      .mockReturnValue({} as NodeJS.Immediate);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('`PRE_RESERVA_INTERVALO_MS=0`: NÃO arma, e avisa em `warn` com a consequência', () => {
    new AgendadorDaPreReserva(
      varredor,
      config({ NODE_ENV: 'production', PRE_RESERVA_INTERVALO_MS: '0' }),
    ).onModuleInit();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('ninguém será avisado'),
    );
  });

  it('ausente: arma com 60 s, e roda ao subir', () => {
    new AgendadorDaPreReserva(
      varredor,
      config({ NODE_ENV: 'production' }),
    ).onModuleInit();

    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      INTERVALO_DA_PRE_RESERVA_MS,
    );
    expect(INTERVALO_DA_PRE_RESERVA_MS).toBe(60_000);
    expect(setImmediateSpy).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('em teste, não arma nada — a suíte chama `executarCiclo()` direto', () => {
    new AgendadorDaPreReserva(
      varredor,
      config({ NODE_ENV: 'test' }),
    ).onModuleInit();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

describe('SPEC-074/AC-022 — o lote, de 1 a 200, só dígitos', () => {
  it.each([
    [undefined, 200, false],
    ['1', 1, false],
    ['007', 7, false],
    ['199', 199, false],
    ['200', 200, false],
    // Abaixo de 1: interruptor disfarçado.
    ['0', 200, true],
    ['-3', 200, true],
    ['-0', 200, true],
    // Acima de 200: desfaria o orçamento (B-01 da 7ª rodada).
    ['201', 200, true],
    ['1000000', 200, true],
    // O que `Number()` aceitaria em silêncio.
    ['2.5', 200, true],
    ['200.0', 200, true],
    [' 150 ', 200, true],
    ['1e2', 200, true],
    ['0x10', 200, true],
    ['+1', 200, true],
    ['abc', 200, true],
    ['', 200, true],
  ])('%p → lote %p (inválido: %p)', (valor, lote, invalido) => {
    expect(loteDaConfiguracao(valor)).toEqual({ lote, invalido });
  });

  it('o padrão É o teto', () => {
    expect(LOTE_DA_PRE_RESERVA).toBe(200);
  });

  it('o seletor lê a variável UMA vez, e avisa em `warn` só quando ela é inválida', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const prisma = {} as PrismaService;

    expect(new SeletorDoLote(prisma, config({})).tamanho).toBe(200);
    expect(warn).not.toHaveBeenCalled();

    expect(
      new SeletorDoLote(prisma, config({ PRE_RESERVA_LOTE: '1' })).tamanho,
    ).toBe(1);
    expect(warn).not.toHaveBeenCalled();

    expect(
      new SeletorDoLote(prisma, config({ PRE_RESERVA_LOTE: '201' })).tamanho,
    ).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
