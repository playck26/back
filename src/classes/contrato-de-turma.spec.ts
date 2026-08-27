import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SPEC-019/REQ-006 (AC-013) — **as rotas que esta spec quebra têm schema de
 * resposta publicado.**
 *
 * ## Por que isto é um teste, e não uma revisão
 *
 * O DEF-012 aconteceu porque mudança de forma de resposta é invisível para o
 * typecheck dos frontends. A REQ-006 mandou publicar schema para as cinco
 * rotas de turma — mas publicar uma vez não é garantia: um
 * `@ApiOkResponse` removido num refactor levaria a proteção junto, **sem
 * derrubar nada**, e o próximo a mudar a forma da resposta descobriria em
 * produção.
 *
 * Este teste lê o `openapi.json` **commitado** e cobra o schema rota a rota.
 * O CI já garante que esse arquivo está em dia (`git diff --exit-code` depois
 * de reexportar), então cobrar nele é cobrar no que o frontend realmente
 * consome.
 *
 * ## O corte é estreito, e é o mesmo da REQ-006
 *
 * Só as rotas que a SPEC-019 quebra. As outras ~74 sem schema são a
 * SPEC-021/TASK-005 — cobrá-las aqui transformaria este teste num mutirão que
 * ninguém consegue deixar verde, e teste que não dá para deixar verde é
 * teste que se desliga.
 */

interface Documento {
  paths: Record<
    string,
    Record<
      string,
      { responses?: Record<string, { content?: Record<string, unknown> }> }
    >
  >;
  components: {
    schemas: Record<string, { properties?: Record<string, unknown> }>;
  };
}

const doc = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'openapi.json'), 'utf8'),
) as Documento;

/** As cinco rotas cujo formato de resposta a SPEC-019 mudou. */
const ROTAS_QUEBRADAS: [string, string][] = [
  ['/api/v1/classes', 'get'],
  ['/api/v1/classes', 'post'],
  ['/api/v1/classes/{id}', 'get'],
  ['/api/v1/classes/{id}', 'patch'],
  ['/api/v1/me/teacher/classes', 'get'],
  // A rota que a 1ª versão da spec esqueceu, e que a validação cruzada pegou.
  ['/api/v1/me/teacher/classes/{id}', 'get'],
];

function temSchemaDeResposta(caminho: string, verbo: string): boolean {
  const op = doc.paths[caminho]?.[verbo];
  if (!op?.responses) return false;
  return Object.values(op.responses).some(
    (r) => r.content !== undefined && Object.keys(r.content).length > 0,
  );
}

describe('SPEC-019/AC-013 — o contrato de resposta de turma está publicado', () => {
  it.each(ROTAS_QUEBRADAS)('%s %s tem schema de resposta', (caminho, verbo) => {
    expect(temSchemaDeResposta(caminho, verbo)).toBe(true);
  });

  it('e `encontros` está no schema como ARRAY, não como campo solto', () => {
    // O defeito que este teste pega: alguém "simplificar" o DTO de volta para
    // `diaSemana`/`horaInicio`/`horaFim`. O schema continuaria publicado, e a
    // checagem acima passaria — mas o contrato teria voltado.
    const turma = doc.components.schemas.TurmaResponseDto;

    expect(turma?.properties?.encontros).toMatchObject({ type: 'array' });
    expect(turma?.properties).not.toHaveProperty('diaSemana');
    expect(turma?.properties).not.toHaveProperty('horaInicio');
    expect(turma?.properties).not.toHaveProperty('horaFim');
  });

  it('o encontro publicado tem os três campos, e só eles', () => {
    const encontro = doc.components.schemas.TurmaEncontroResponseDto;

    expect(Object.keys(encontro?.properties ?? {}).sort()).toEqual([
      'diaSemana',
      'horaFim',
      'horaInicio',
    ]);
  });

  it('a rota do professor devolve encontros também — nos DOIS formatos', () => {
    // Lista e detalhe são schemas distintos de propósito (o detalhe traz
    // alunos e não traz `totalAlunos`). Um deles ficar para trás foi
    // exatamente o BLOQUEADOR 1 da validação cruzada.
    for (const nome of [
      'TurmaDoProfessorResponseDto',
      'TurmaDoProfessorDetalheResponseDto',
    ]) {
      expect(doc.components.schemas[nome]?.properties).toHaveProperty(
        'encontros',
      );
      expect(doc.components.schemas[nome]?.properties).not.toHaveProperty(
        'diaSemana',
      );
    }
  });
});
