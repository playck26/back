import { UnprocessableEntityException } from '@nestjs/common';
import {
  ENCONTROS_SOBREPOSTOS,
  ENCONTRO_HORARIO_INVALIDO,
  TURMA_SEM_ENCONTRO,
  validarEncontros,
  type EncontroDaTurma,
} from './encontros';

/**
 * SPEC-019/TASK-002 — a regra dos encontros, testada isolada.
 *
 * Ela vive fora do serviço de propósito: é a regra nova desta task, e testá-la
 * através de `create`/`update` exigiria montar transação, quadra e empresa
 * para provar aritmética de horário.
 */

const enc = (
  diaSemana: number,
  horaInicio: string,
  horaFim: string,
): EncontroDaTurma => ({ diaSemana, horaInicio, horaFim });

function corpoDoErro(fn: () => void): Record<string, unknown> {
  try {
    fn();
  } catch (erro) {
    if (erro instanceof UnprocessableEntityException) {
      return erro.getResponse() as Record<string, unknown>;
    }
    throw erro;
  }
  throw new Error('esperava uma recusa, e nada foi lançado');
}

describe('validarEncontros', () => {
  it('aceita um encontro', () => {
    expect(() => validarEncontros([enc(2, '18:00', '19:00')])).not.toThrow();
  });

  it('aceita três encontros em dias diferentes', () => {
    expect(() =>
      validarEncontros([
        enc(1, '07:00', '08:00'),
        enc(3, '18:00', '19:30'),
        enc(6, '09:00', '10:00'),
      ]),
    ).not.toThrow();
  });

  describe('INV-051 — pelo menos um encontro', () => {
    it('lista vazia é recusada com TURMA_SEM_ENCONTRO', () => {
      expect(corpoDoErro(() => validarEncontros([]))).toMatchObject({
        code: TURMA_SEM_ENCONTRO,
      });
    });
  });

  describe('AC-005 — horário inválido recusa a turma INTEIRA', () => {
    it('fim antes do início', () => {
      expect(
        corpoDoErro(() => validarEncontros([enc(2, '19:00', '18:00')])),
      ).toMatchObject({ code: ENCONTRO_HORARIO_INVALIDO });
    });

    it('duração zero também', () => {
      expect(
        corpoDoErro(() => validarEncontros([enc(2, '18:00', '18:00')])),
      ).toMatchObject({ code: ENCONTRO_HORARIO_INVALIDO });
    });

    it('e a resposta diz QUAL encontro', () => {
      // Uma turma de quatro encontros que recebe "termina antes de começar"
      // manda o gestor conferir os quatro. Com o índice, ele vai direto.
      const corpo = corpoDoErro(() =>
        validarEncontros([
          enc(1, '07:00', '08:00'),
          enc(3, '18:00', '19:00'),
          enc(5, '20:00', '19:00'),
        ]),
      );

      expect(corpo.encontro).toBe(2);
      expect(String(corpo.message)).toContain('3');
    });

    it('um encontro inválido derruba os válidos junto', () => {
      // Aceitar os bons e descartar o ruim criaria uma turma que não é a que
      // a pessoa pediu, sem ela saber.
      expect(() =>
        validarEncontros([enc(1, '07:00', '08:00'), enc(1, '09:00', '08:00')]),
      ).toThrow(UnprocessableEntityException);
    });
  });

  describe('AC-006 — encontros que se sobrepõem entre si', () => {
    it('recusa sobreposição no mesmo dia', () => {
      expect(
        corpoDoErro(() =>
          validarEncontros([
            enc(2, '18:00', '19:00'),
            enc(2, '18:30', '19:30'),
          ]),
        ),
      ).toMatchObject({ code: ENCONTROS_SOBREPOSTOS });
    });

    it('e diz QUAIS dois', () => {
      const corpo = corpoDoErro(() =>
        validarEncontros([
          enc(1, '07:00', '08:00'),
          enc(4, '18:00', '19:00'),
          enc(4, '18:30', '19:30'),
        ]),
      );

      expect(corpo.encontros).toEqual([1, 2]);
    });

    it('AC-007 — mesmo dia SEM sobreposição é aceito', () => {
      // Turma que treina terça de manhã e terça à noite é caso real. Se
      // alguém trocar a regra para "um encontro por dia", este teste cai.
      expect(() =>
        validarEncontros([enc(2, '07:00', '08:00'), enc(2, '18:00', '19:00')]),
      ).not.toThrow();
    });

    it('mesma hora em dias DIFERENTES é aceito', () => {
      expect(() =>
        validarEncontros([enc(2, '18:00', '19:00'), enc(4, '18:00', '19:00')]),
      ).not.toThrow();
    });

    describe('a fronteira é SEMIABERTA, igual à de ocupações', () => {
      it('encostar não é sobrepor: 08:00–09:00 e 09:00–10:00', () => {
        // REQ-010 da SPEC-010: conflito entre ocupações é semiaberto. Usar
        // outra semântica aqui faria a API recusar um par que o banco
        // aceitaria — e o gestor não teria como entender por quê.
        expect(() =>
          validarEncontros([
            enc(2, '08:00', '09:00'),
            enc(2, '09:00', '10:00'),
          ]),
        ).not.toThrow();
      });

      it('um minuto de invasão já é sobreposição', () => {
        expect(() =>
          validarEncontros([
            enc(2, '08:00', '09:01'),
            enc(2, '09:00', '10:00'),
          ]),
        ).toThrow(UnprocessableEntityException);
      });

      it('um encontro contido no outro é sobreposição', () => {
        expect(() =>
          validarEncontros([
            enc(2, '08:00', '12:00'),
            enc(2, '09:00', '10:00'),
          ]),
        ).toThrow(UnprocessableEntityException);
      });

      it('e a ordem da lista não muda o resultado', () => {
        // A varredura é par a par; se fosse "cada um contra o anterior", uma
        // lista fora de ordem passaria.
        expect(() =>
          validarEncontros([
            enc(2, '09:00', '10:00'),
            enc(2, '08:00', '12:00'),
          ]),
        ).toThrow(UnprocessableEntityException);
      });

      it('sobreposição entre o PRIMEIRO e o ÚLTIMO é pega', () => {
        expect(() =>
          validarEncontros([
            enc(2, '08:00', '12:00'),
            enc(3, '08:00', '09:00'),
            enc(4, '08:00', '09:00'),
            enc(2, '11:00', '13:00'),
          ]),
        ).toThrow(UnprocessableEntityException);
      });
    });
  });
});
