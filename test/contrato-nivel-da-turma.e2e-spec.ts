import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SPEC-079/AC-013 — **o contrato diz a verdade sobre o nível.**
 *
 * Desde a migração B, toda turma tem nível (`turmas.nivel_id NOT NULL`,
 * ADR-029). O `openapi.json` é o que os três frontends consomem
 * (`gen:api-types`, SPEC-067): se ele continuasse dizendo que o nível da turma
 * pode ser nulo, cada tela seguiria tratando um caso que não existe — e,
 * pior, um schema de ALUNO que perdesse o `nullable` por engano mentiria no
 * sentido contrário (aluno sem nível continua existindo, ADR-026).
 *
 * Lê o arquivo **commitado**; o CI regenera e recusa diferença
 * (`git diff --exit-code` do `openapi:export`), então o par cobre os dois
 * lados, como no `contrato-de-resposta.spec.ts`.
 */

interface Propriedade {
  nullable?: boolean;
  type?: string;
  format?: string;
}
interface Schema {
  properties?: Record<string, Propriedade>;
  required?: string[];
}

const openapi = JSON.parse(
  readFileSync(join(__dirname, '..', 'openapi.json'), 'utf8'),
) as { components: { schemas: Record<string, Schema> } };
const schemas = openapi.components.schemas;

/** Os oito schemas de TURMA, e qual campo de nível cada um publica. */
const DE_TURMA: Record<string, string[]> = {
  TurmaResponseDto: ['nivelId'],
  TurmaComLotacaoResponseDto: ['nivelId'],
  TurmaDetalheResponseDto: ['nivelId'],
  TurmaDisponivelResponseDto: ['nivelId', 'nivelNome'],
  OportunidadeDeReposicaoResponseDto: ['nivelId', 'nivelNome'],
  TurmaDoProfessorResponseDto: ['nivelNome'],
  TurmaDoProfessorDetalheResponseDto: ['nivelNome'],
  TurmaDoAlunoDetalheResponseDto: ['nivelNome'],
};

/** Os seis de ALUNO: continuam anuláveis (aluno sem nível conta como o primeiro). */
const DE_ALUNO = [
  'AlunoResponseDto',
  'AlunoComSenhaTemporariaResponseDto',
  'LinhaValidaDto',
  'VisitanteDaOcorrenciaResponseDto',
  'ColegaDeTurmaResponseDto',
  'AlunoDoProfessorResponseDto',
];

describe('SPEC-079/AC-013 — o nível da turma no contrato', () => {
  it('as duas listas são as da spec: 8 de turma e 6 de aluno, todos existentes', () => {
    expect(Object.keys(DE_TURMA)).toHaveLength(8);
    expect(DE_ALUNO).toHaveLength(6);
    for (const nome of [...Object.keys(DE_TURMA), ...DE_ALUNO]) {
      expect({ nome, existe: nome in schemas }).toEqual({ nome, existe: true });
    }
  });

  for (const [nome, campos] of Object.entries(DE_TURMA)) {
    for (const campo of campos) {
      it(`${nome}.${campo}: obrigatório e NÃO anulável`, () => {
        const s = schemas[nome];
        expect(s.properties?.[campo]).toBeDefined();
        expect(s.properties?.[campo].nullable).not.toBe(true);
        expect(s.required ?? []).toContain(campo);
      });
    }
  }

  it('nenhum schema de turma ficou com um campo de nível anulável fora da lista', () => {
    // Pega o schema de turma novo, ou o campo novo, que ninguém pôs aqui.
    const anulaveis = Object.entries(schemas)
      .filter(([nome]) => /^Turma|^Oportunidade/.test(nome))
      .flatMap(([nome, s]) =>
        Object.entries(s.properties ?? {})
          .filter(([c, p]) => /^nivel(Id|Nome)$/.test(c) && p.nullable === true)
          .map(([c]) => `${nome}.${c}`),
      );
    expect(anulaveis).toEqual([]);
  });

  for (const nome of DE_ALUNO) {
    it(`${nome}: o nível do ALUNO continua anulável`, () => {
      const campos = Object.entries(schemas[nome].properties ?? {}).filter(
        ([c]) => /^nivel(Id|Nome)$/.test(c),
      );
      expect(campos.length).toBeGreaterThan(0);
      for (const [c, p] of campos) {
        expect({ campo: c, nullable: p.nullable }).toEqual({
          campo: c,
          nullable: true,
        });
      }
    });
  }

  it('CreateClassDto.nivelId é obrigatório', () => {
    const s = schemas.CreateClassDto;
    expect(s.properties?.nivelId).toBeDefined();
    expect(s.required ?? []).toContain('nivelId');
  });
});
