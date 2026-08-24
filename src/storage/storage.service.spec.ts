import { NotFoundException } from '@nestjs/common';
import type { StorageProvider } from './storage-provider.interface';
import { StorageService } from './storage.service';

// SPEC-017/TASK-003 — a INV-037 não diz "existe um parser". Diz que o
// `StorageService` NUNCA assina chave crua. Um parser que o chamador pode
// esquecer de chamar não impõe invariante nenhuma, então o que este arquivo
// prova é que **não existe caminho** daqui até uma assinatura sem conferência.

const EMPRESA = 'a1b2c3d4-11ef-4111-8111-1f1e1d1c1b1a';
const OUTRA_EMPRESA = 'b2c3d4e5-22ef-4222-8222-2f2e2d2c2b2a';
const RECURSO = 'c3d4e5f6-33ef-4333-8333-3f3e3d3c3b3a';
const SHA = 'a'.repeat(64);

const chaveDe = (empresa: string, tipo: string, recurso = RECURSO) =>
  `empresas/${empresa}/${tipo}/${recurso}/${SHA}.webp`;

describe('StorageService', () => {
  let provider: jest.Mocked<StorageProvider>;
  let service: StorageService;

  beforeEach(() => {
    provider = {
      gravar: jest.fn(),
      apagar: jest.fn(),
      metadados: jest.fn(),
      urlPublica: jest.fn().mockReturnValue('https://cdn.exemplo/objeto'),
      urlAssinada: jest.fn().mockResolvedValue('https://assinada.exemplo'),
    };
    service = new StorageService(provider);
  });

  describe('o regime sai do TIPO, não do chamador', () => {
    it('quadra é pública: CDN, sem assinar', async () => {
      const url = await service.urlDeLeitura({
        key: chaveDe(EMPRESA, 'quadra'),
        companyId: EMPRESA,
        tipo: 'quadra',
        recursoId: RECURSO,
      });

      expect(url).toBe('https://cdn.exemplo/objeto');
      expect(provider.urlPublica).toHaveBeenCalledWith(
        chaveDe(EMPRESA, 'quadra'),
      );
      expect(provider.urlAssinada).not.toHaveBeenCalled();
    });

    it('perfil é privado: assina, e SEM parâmetro de expiração', async () => {
      const url = await service.urlDeLeitura({
        key: chaveDe(EMPRESA, 'perfil'),
        companyId: EMPRESA,
        tipo: 'perfil',
        recursoId: RECURSO,
      });

      expect(url).toBe('https://assinada.exemplo');
      // Ressalva da validação cruzada: expiração escolhida no ponto de uso é
      // política de segurança decidida onde ela sempre acaba errada. O
      // serviço chama com UM argumento; o teto da AC-010 mora no adaptador.
      expect(provider.urlAssinada).toHaveBeenCalledWith(
        chaveDe(EMPRESA, 'perfil'),
      );
      expect(provider.urlAssinada.mock.calls[0]).toHaveLength(1);
      expect(provider.urlPublica).not.toHaveBeenCalled();
    });

    it('logo é pública e professor é privado', async () => {
      await service.urlDeLeitura({
        key: chaveDe(EMPRESA, 'logo'),
        companyId: EMPRESA,
        tipo: 'logo',
        recursoId: RECURSO,
      });
      expect(provider.urlPublica).toHaveBeenCalled();

      await service.urlDeLeitura({
        key: chaveDe(EMPRESA, 'professor'),
        companyId: EMPRESA,
        tipo: 'professor',
        recursoId: RECURSO,
      });
      expect(provider.urlAssinada).toHaveBeenCalled();
    });

    it('expõe a visibilidade como função do tipo', () => {
      expect(service.visibilidadeDoTipo('quadra')).toBe('publico');
      expect(service.visibilidadeDoTipo('perfil')).toBe('privado');
    });
  });

  describe('404 e nada mais — REQ-006/AC-018', () => {
    const casos: Array<[string, unknown]> = [
      ['chave de outra empresa', chaveDe(OUTRA_EMPRESA, 'quadra')],
      ['chave de outro tipo', chaveDe(EMPRESA, 'perfil')],
      ['chave de outro recurso', chaveDe(EMPRESA, 'quadra', OUTRA_EMPRESA)],
      ['chave corrompida', 'empresas/lixo'],
      ['travessia de caminho', `empresas/${EMPRESA}/quadra/../${SHA}.webp`],
      ['UUID em maiúsculas', chaveDe(EMPRESA.toUpperCase(), 'quadra')],
      ['chave vazia', ''],
      ['chave nula', null],
      ['chave que nem é string', 42],
    ];

    it.each(casos)('recusa %s com 404', async (_rotulo, key) => {
      const pedido = {
        key,
        companyId: EMPRESA,
        tipo: 'quadra',
        recursoId: RECURSO,
      } as const;

      await expect(service.urlDeLeitura(pedido)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('NUNCA toca no provider quando recusa — não assina nem consulta', async () => {
      // É o coração da INV-037: recusar depois de assinar seria assinar.
      for (const [, key] of casos) {
        await service
          .urlDeLeitura({
            key,
            companyId: EMPRESA,
            tipo: 'quadra',
            recursoId: RECURSO,
          })
          .catch(() => undefined);
      }
      expect(provider.urlAssinada).not.toHaveBeenCalled();
      expect(provider.urlPublica).not.toHaveBeenCalled();
      expect(provider.metadados).not.toHaveBeenCalled();
    });

    it('a resposta é 404 e não 403, e não diz o motivo', async () => {
      // 403 confirmaria que o objeto existe, e a pergunta que estamos
      // protegendo é exatamente "existe uma foto neste id?".
      let erro: NotFoundException | null = null;
      try {
        await service.urlDeLeitura({
          key: chaveDe(OUTRA_EMPRESA, 'quadra'),
          companyId: EMPRESA,
          tipo: 'quadra',
          recursoId: RECURSO,
        });
      } catch (e) {
        erro = e as NotFoundException;
      }
      if (erro === null) {
        throw new Error('deveria ter recusado');
      }

      const corpo = erro.getResponse() as Record<string, unknown>;
      expect(erro.getStatus()).toBe(404);
      expect(corpo.code).toBe('OBJETO_NAO_ENCONTRADO');
      expect(JSON.stringify(corpo)).not.toContain(OUTRA_EMPRESA);
      expect(JSON.stringify(corpo)).not.toContain('outra empresa');
    });
  });
});
