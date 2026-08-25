import { ALERTAS, AlertaDeStorage } from './alerta-de-storage';
import {
  LIMITE_DO_BUCKET_BYTES,
  MAXIMO_DE_PAGINAS,
  MedidorDeBucket,
} from './medidor-de-bucket.service';
import type {
  StorageProvider,
  UsoDoBucket,
} from './storage-provider.interface';

// SPEC-017/TASK-006 — NFR-004.
//
// **50 GB não é o limite do bucket; é a cota da CONTA dividida por dois.** A
// assinatura do Spaces cobre 250 GB somados entre todos os buckets, e o
// `opinii-media` está na mesma conta (ADR-015). Alertar cedo dá margem para
// reagir antes de o produto do lado pagar por um problema que não é dele.

const GB = 1024 * 1024 * 1024;

class AlertaEspiao extends AlertaDeStorage {
  readonly disparados: { codigo: string; detalhe?: unknown }[] = [];
  disparar(codigo: string, detalhe?: unknown): void {
    this.disparados.push({ codigo, detalhe });
  }
}

function medidorCom(uso: UsoDoBucket) {
  const alerta = new AlertaEspiao();
  const provider = {
    medirUso: jest.fn().mockResolvedValue(uso),
  } as unknown as StorageProvider;
  return {
    alerta,
    provider,
    medidor: new MedidorDeBucket(provider, alerta),
  };
}

describe('MedidorDeBucket', () => {
  it('não alerta com o bucket pequeno', async () => {
    const { medidor, alerta } = medidorCom({
      objetos: 120,
      bytes: 2 * GB,
      completo: true,
    });

    const uso = await medidor.medirEAlertar();

    expect(uso.bytes).toBe(2 * GB);
    expect(alerta.disparados).toEqual([]);
  });

  it('alerta acima de 50 GB', async () => {
    const { medidor, alerta } = medidorCom({
      objetos: 90_000,
      bytes: 51 * GB,
      completo: true,
    });

    await medidor.medirEAlertar();

    expect(alerta.disparados).toHaveLength(1);
    expect(alerta.disparados[0].codigo).toBe(ALERTAS.BUCKET_GRANDE);
    expect(alerta.disparados[0].detalhe).toMatchObject({ gigabytes: 51 });
  });

  it('exatamente no limite NÃO alerta — a fronteira é inclusiva', async () => {
    const { medidor, alerta } = medidorCom({
      objetos: 1,
      bytes: LIMITE_DO_BUCKET_BYTES,
      completo: true,
    });
    await medidor.medirEAlertar();
    expect(alerta.disparados).toEqual([]);
  });

  it('alerta quando a varredura foi INCOMPLETA, mesmo com o bucket pequeno', async () => {
    // Bucket grande demais para varrer é bucket grande demais. E um número
    // parcial que se apresenta como total é pior que número nenhum: levaria
    // a operação a concluir "está tudo bem" olhando meia medição.
    const { medidor, alerta } = medidorCom({
      objetos: 200_000,
      bytes: 1 * GB,
      completo: false,
    });

    await medidor.medirEAlertar();

    expect(alerta.disparados).toHaveLength(1);
    expect(alerta.disparados[0].detalhe).toMatchObject({ completo: false });
  });

  it('passa o teto de páginas para o provider', async () => {
    const { medidor, provider } = medidorCom({
      objetos: 0,
      bytes: 0,
      completo: true,
    });
    await medidor.medirEAlertar();
    expect(provider.medirUso).toHaveBeenCalledWith(MAXIMO_DE_PAGINAS);
  });

  it('o limite é 50 GB e o teto de páginas cobre 200 mil objetos', () => {
    // Números congelados: mudá-los é decisão de operação, não refactor.
    expect(LIMITE_DO_BUCKET_BYTES).toBe(50 * GB);
    expect(MAXIMO_DE_PAGINAS * 1000).toBe(200_000);
  });
});
