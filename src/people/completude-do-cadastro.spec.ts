import {
  CAMPOS_DA_COMPLETUDE,
  calcularCompletude,
} from './completude-do-cadastro';

/**
 * SPEC-036/REQ-003 — a tabela-verdade da completude.
 *
 * **Função pura, teste puro.** Um db-spec aqui seria cerimônia: não há
 * constraint, transação nem concorrência envolvida — há uma contagem, e uma
 * contagem se prova contando.
 *
 * O caso que mais importa é o do `undefined`: um `select` parcial do Prisma
 * **não traz a chave**, e se a função testasse só `null`, um campo fora da
 * consulta contaria como preenchido. A barra subiria sozinha, e ninguém
 * desconfiaria de um número que só fica maior.
 */
const COMPLETO = {
  nome: 'Ana',
  email: 'ana@clube.local',
  telefone: '11999990000',
  dataNascimento: new Date('1990-05-10'),
  emergenciaNome: 'Beto',
  emergenciaTelefone: '11988887777',
  nivelId: 'n-1',
};

describe('SPEC-036 — calcularCompletude', () => {
  it('são SETE campos, e a ordem é a do formulário (AC-010)', () => {
    // A ordem não é alfabética nem a do banco: é a que a tela deve pedir.
    // Fixá-la aqui é o que impede alguém reordenar a constante sem perceber
    // que a tela do Cliente pede na ordem que ela dita.
    expect([...CAMPOS_DA_COMPLETUDE]).toEqual([
      'nome',
      'email',
      'telefone',
      'dataNascimento',
      'emergenciaNome',
      'emergenciaTelefone',
      'nivelId',
    ]);
  });

  it('tudo preenchido: 100% e `faltam` vazio', () => {
    expect(calcularCompletude(COMPLETO)).toEqual({
      percentual: 100,
      faltam: [],
    });
  });

  it('o piso real é 29%, e não 0% (AC-011)', () => {
    // `nome` e `email` são NOT NULL em `usuarios`: todo aluno nasce com dois
    // dos sete. Barra em zero mentiria sobre o trabalho já feito — e quem vê
    // 0% depois de cadastrar alguém conclui que o cadastro não salvou.
    const recemCriado = calcularCompletude({
      nome: 'Ana',
      email: 'ana@clube.local',
    });
    expect(recemCriado.percentual).toBe(29);
    expect(recemCriado.faltam).toEqual([
      'telefone',
      'dataNascimento',
      'emergenciaNome',
      'emergenciaTelefone',
      'nivelId',
    ]);
  });

  it('objeto vazio: 0%, e os sete faltando', () => {
    // Não acontece pelo caminho do produto (nome e email são NOT NULL), mas a
    // função é pública e não vai adivinhar isso.
    const zero = calcularCompletude({});
    expect(zero.percentual).toBe(0);
    expect(zero.faltam).toHaveLength(7);
  });

  it('**`undefined` conta como AUSENTE** — o caso do `select` parcial', () => {
    // Se a função testasse só `null`, um campo que a consulta não trouxe
    // contaria como preenchido. **É o único erro aqui que faz o número subir
    // sozinho**, e por isso é o caso que este arquivo existe para guardar.
    const semAsChaves = calcularCompletude({
      nome: 'Ana',
      email: 'ana@clube.local',
      // as outras cinco chaves simplesmente não existem no objeto
    });
    expect(semAsChaves.percentual).toBe(29);
  });

  it('texto em branco NÃO conta como preenchido', () => {
    // O CHECK do banco impede `''` daqui para frente; linha anterior à spec
    // pode trazer o que quiser, e `nome: '   '` contando faria a barra mentir
    // sobre dado legado.
    const comBranco = calcularCompletude({
      ...COMPLETO,
      emergenciaNome: '   ',
    });
    expect(comBranco.percentual).toBe(86);
    expect(comBranco.faltam).toEqual(['emergenciaNome']);
  });

  it('a percentagem arredonda, e a tabela inteira confere', () => {
    // 7 campos não dividem redondo: 1/7 = 14,29. Fixar a tabela toda é o que
    // impede uma troca de `round` por `floor` passar despercebida — `floor`
    // mostraria 71 para 5 de 7 e 85 para 6 de 7, e a barra pareceria travada.
    const esperado = [0, 14, 29, 43, 57, 71, 86, 100];
    for (let n = 0; n <= 7; n++) {
      const dados: Record<string, string> = {};
      for (const campo of CAMPOS_DA_COMPLETUDE.slice(0, n)) {
        dados[campo] = 'x';
      }
      expect(calcularCompletude(dados).percentual).toBe(esperado[n]);
    }
  });

  it('`Date` conta como preenchido, e não cai no ramo de string', () => {
    // `dataNascimento` chega do Prisma como `Date`. Uma implementação que
    // fizesse `String(valor).trim() !== ''` também passaria — mas quebraria no
    // dia em que alguém guardasse `new Date('invalid')`.
    const so = calcularCompletude({ dataNascimento: new Date('1990-05-10') });
    expect(so.faltam).not.toContain('dataNascimento');
  });
});
