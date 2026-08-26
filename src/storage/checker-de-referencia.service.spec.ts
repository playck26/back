import { CheckerDeReferencia } from './checker-de-referencia.service';
import { KeyReferenceRegistry } from './key-reference-checker';
import { COLUNAS_DE_MIDIA } from './colunas-de-midia';

/**
 * SPEC-018/TASK-007 — as provas do checker.
 *
 * **O que este arquivo guarda é a diferença entre deixar lixo e apagar
 * arquivo em uso.** Enquanto não havia checker, o registro respondia `true`
 * a tudo e o worker não apagava nada (INV-044). Com ele registrado, o worker
 * apaga de verdade — então um erro aqui não custa espaço, custa a imagem de
 * alguém.
 */

const CHAVE =
  'empresas/11111111-1111-4111-8111-111000180031/perfil/22222222-2222-4222-8222-222000180032/' +
  'a'.repeat(64) +
  '.webp';

/**
 * Um dublê de Prisma em que **cada coluna responde o que o teste mandar**.
 * A chave do mapa é `Modelo.campo`, igual à da lista central — assim um
 * teste que quisesse mentir sobre qual coluna respondeu não teria como.
 */
function montar(respostas: Record<string, number | Error> = {}) {
  const consultadas: string[] = [];

  const contarPara = (nome: string) =>
    jest.fn(() => {
      consultadas.push(nome);
      const r = respostas[nome] ?? 0;
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve(r);
    });

  const prisma = {
    usuario: { count: contarPara('Usuario.fotoKey') },
    professor: { count: contarPara('Professor.fotoKey') },
    quadra: { count: contarPara('Quadra.imagemKey') },
    empresa: { count: contarPara('Empresa.logoKey') },
  };

  const registry = new KeyReferenceRegistry();
  const checker = new CheckerDeReferencia(prisma as never, registry);

  return { checker, registry, consultadas, prisma };
}

describe('AC-015 — referenciada se QUALQUER coluna apontar', () => {
  it('nenhuma aponta: não referenciada', async () => {
    const { checker } = montar();
    await expect(checker.estaReferenciada(CHAVE)).resolves.toBe(false);
  });

  it('cada uma das quatro, sozinha, basta para dizer "referenciada"', async () => {
    // Varredura e não caso escolhido: a AC-015 é sobre **qualquer** coluna, e
    // um teste com uma só provaria uma só. Se alguém acrescentar uma coluna à
    // lista central e esquecer de ligá-la, este teste falha na coluna nova.
    for (const coluna of COLUNAS_DE_MIDIA) {
      const nome = `${coluna.modelo}.${coluna.campo}`;
      const { checker } = montar({ [nome]: 1 });
      await expect(checker.estaReferenciada(CHAVE)).resolves.toBe(true);
    }
  });

  it('para no primeiro "sim" — não consulta as outras à toa', async () => {
    const primeira = `${COLUNAS_DE_MIDIA[0].modelo}.${COLUNAS_DE_MIDIA[0].campo}`;
    const { checker, consultadas } = montar({ [primeira]: 1 });

    await checker.estaReferenciada(CHAVE);

    expect(consultadas).toEqual([primeira]);
  });

  it('consulta TODAS antes de dizer "não referenciada"', async () => {
    // O outro lado do curto-circuito, e o que importa de verdade: dizer "não"
    // sem ter perguntado a todas é o caminho para apagar arquivo em uso.
    const { checker, consultadas } = montar();

    await checker.estaReferenciada(CHAVE);

    expect(consultadas).toEqual(
      COLUNAS_DE_MIDIA.map((c) => `${c.modelo}.${c.campo}`),
    );
  });

  it('a consulta é pela chave EXATA, não por prefixo', async () => {
    // `startsWith` aqui faria uma chave nova de um recurso "proteger" a
    // antiga do mesmo recurso, e a antiga nunca seria apagada.
    const { checker, prisma } = montar();
    await checker.estaReferenciada(CHAVE);
    expect(prisma.usuario.count).toHaveBeenCalledWith({
      where: { fotoKey: CHAVE },
    });
  });
});

describe('fail-closed — banco indisponível significa "não sei"', () => {
  it('consulta que estoura devolve TRUE, e não propaga a exceção', async () => {
    // Propagar mataria o ciclo do worker; devolver `false` mandaria apagar um
    // arquivo sobre o qual não se sabe nada. `true` deixa o objeto no bucket
    // por mais um ciclo, que custa centavos.
    const primeira = `${COLUNAS_DE_MIDIA[0].modelo}.${COLUNAS_DE_MIDIA[0].campo}`;
    const { checker } = montar({ [primeira]: new Error('conexão caiu') });

    await expect(checker.estaReferenciada(CHAVE)).resolves.toBe(true);
  });

  it('falha na ÚLTIMA coluna também devolve TRUE', async () => {
    // O caso que um teste com uma coluna só não pegaria: as três primeiras
    // dizem "não aponta", a quarta estoura, e um `return false` no fim do
    // laço transformaria o erro em permissão de apagar.
    const ultima = COLUNAS_DE_MIDIA[COLUNAS_DE_MIDIA.length - 1];
    const nome = `${ultima.modelo}.${ultima.campo}`;
    const { checker } = montar({ [nome]: new Error('timeout') });

    await expect(checker.estaReferenciada(CHAVE)).resolves.toBe(true);
  });

  it('a CHAVE não vai para o log do erro', async () => {
    // Ela carrega `company_id` e o id do recurso, e este log pode acabar num
    // agregador. O que vai é qual coluna falhou, que é o que serve.
    const primeira = `${COLUNAS_DE_MIDIA[0].modelo}.${COLUNAS_DE_MIDIA[0].campo}`;
    const { checker } = montar({ [primeira]: new Error('conexão caiu') });

    const registrados: unknown[] = [];
    const espiao = jest
      .spyOn(
        (checker as unknown as { logger: { error: (o: unknown) => void } })
          .logger,
        'error',
      )
      .mockImplementation((o: unknown) => {
        registrados.push(o);
      });

    await checker.estaReferenciada(CHAVE);
    espiao.mockRestore();

    expect(registrados).toHaveLength(1);
    expect(JSON.stringify(registrados[0])).not.toContain(CHAVE);
    expect(JSON.stringify(registrados[0])).toContain('Usuario');
  });
});

describe('AC-016 — o registro é o que tira o worker do fail-closed', () => {
  it('antes do boot, o registro responde TRUE a qualquer chave (INV-044)', async () => {
    const { registry } = montar();
    expect(registry.temChecker()).toBe(false);
    // Sem checker, tudo é "referenciada" — o worker não apaga nada.
    await expect(registry.estaReferenciada(CHAVE)).resolves.toBe(true);
  });

  it('`onModuleInit` registra, e a partir daí a resposta é a do checker', async () => {
    const { checker, registry } = montar();

    checker.onModuleInit();

    expect(registry.temChecker()).toBe(true);
    // Agora "nenhuma coluna aponta" chega ao worker como `false`, e ele apaga.
    await expect(registry.estaReferenciada(CHAVE)).resolves.toBe(false);
  });

  it('registrar duas vezes é recusado — dois donos da mesma pergunta', () => {
    const { checker } = montar();
    checker.onModuleInit();
    expect(() => checker.onModuleInit()).toThrow(/já existe/i);
  });
});
