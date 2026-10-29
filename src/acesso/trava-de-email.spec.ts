import {
  cenariosDeAlunoOuProfessor,
  contaCasaComFiltro,
  restaurarChaveDoEmailACadaTeste,
  type ContaNoDuble,
} from '../../test/utils/spec-086-contas-no-duble';
import {
  conflitoDeContasDaEmpresa,
  contaEmConflitoNaEmpresa,
} from './trava-de-email';

/**
 * DEF-040 — **as duas formas da regra de conflito de e-mail concordam.**
 *
 * A importação lê sob a trava todas as contas dos e-mails do arquivo (só pelo
 * e-mail, na instrução das referenciadas) e decide o conflito em memória por
 * `contaEmConflitoNaEmpresa`; a conferência de fora continua pedindo ao banco
 * pelo filtro de `conflitoDeContasDaEmpresa`. Se as duas divergissem, a
 * importação recusaria sob a trava o que o relatório aceitou (ou o
 * contrário).
 *
 * A prova é conta a conta, com o avaliador de filtros do dublê da SPEC-086
 * (o mesmo que os unitários das entradas E1 a E8 usam), nas contas de todos
 * os cenários AC-003/AC-017 — e com a chave nos DOIS estados para cada conta,
 * e não só no do cenário.
 */
describe('DEF-040 — contaEmConflitoNaEmpresa concorda com conflitoDeContasDaEmpresa', () => {
  const chave = restaurarChaveDoEmailACadaTeste();
  const EMAIL = 'def040@x.com';
  const ALVO = 'empresa-alvo';

  const contas: ContaNoDuble[] = [
    ...new Map(
      cenariosDeAlunoOuProfessor(EMAIL, ALVO)
        .flatMap((c) => c.contas)
        .map((c) => [c.id, c]),
    ).values(),
  ];

  it('a matriz tem contas na alvo, de fora, de gestão e sem empresa', () => {
    expect(contas.map((c) => [c.companyId === ALVO, c.role]).sort()).toEqual(
      [
        [false, 'aluno'],
        [false, 'company_admin'],
        [false, 'professor'],
        [false, 'super_admin'],
        [true, 'aluno'],
        [true, 'professor'],
      ].sort(),
    );
  });

  it.each(['ligada', 'desligada'] as const)(
    'chave %s: a mesma decisão, conta a conta',
    (estado) => {
      if (estado === 'ligada') chave.ligar();
      else chave.desligar();
      const filtro = conflitoDeContasDaEmpresa([EMAIL], ALVO);
      const pelaRegra = contas.map((c) => contaEmConflitoNaEmpresa(c, ALVO));
      const peloFiltro = contas.map((c) =>
        contaCasaComFiltro(c, filtro as Record<string, unknown>),
      );
      expect(pelaRegra).toEqual(peloFiltro);
      // E a matriz distingue os dois estados: com a chave ligada, a conta de
      // aluno de OUTRA empresa não é conflito; desligada, é.
      const deFora = contas.findIndex(
        (c) => c.role === 'aluno' && c.companyId !== ALVO,
      );
      expect(pelaRegra[deFora]).toBe(estado === 'desligada');
    },
  );
});
