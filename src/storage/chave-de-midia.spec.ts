import {
  conferirChave,
  montarChave,
  parsearChave,
  TIPOS_CONHECIDOS,
  TIPOS_DE_MIDIA,
  visibilidadeDe,
  type PartesDaChave,
} from './chave-de-midia';

// SPEC-017/TASK-003 — a gramática da chave.
//
// O parser é TOTAL (AC-019): nenhuma entrada faz ele lançar. E é a segunda
// camada real (INV-037): pega chave adulterada no BANCO, cenário que o
// escopo por token não pega porque token e prefixo leem a mesma coisa.

const EMPRESA = 'a1b2c3d4-11ef-4111-8111-1f1e1d1c1b1a';
const OUTRA_EMPRESA = 'b2c3d4e5-22ef-4222-8222-2f2e2d2c2b2a';
const RECURSO = 'c3d4e5f6-33ef-4333-8333-3f3e3d3c3b3a';
const OUTRO_RECURSO = 'd4e5f6a7-44ef-4444-8444-4f4e4d4c4b4a';
const SHA = 'a'.repeat(64);

const PARTES: PartesDaChave = {
  companyId: EMPRESA,
  tipo: 'quadra',
  recursoId: RECURSO,
  sha256: SHA,
};

const CHAVE = `empresas/${EMPRESA}/quadra/${RECURSO}/${SHA}.webp`;

describe('a gramática da chave', () => {
  it('monta exatamente `empresas/<company_id>/<tipo>/<recurso>/<sha>.webp`', () => {
    expect(montarChave(PARTES)).toBe(CHAVE);
  });

  it('parseia de volta tudo o que montou', () => {
    const resultado = parsearChave(CHAVE);
    expect(resultado).toEqual({
      valida: true,
      chave: {
        key: CHAVE,
        companyId: EMPRESA,
        tipo: 'quadra',
        recursoId: RECURSO,
        sha256: SHA,
        visibilidade: 'publico',
      },
    });
  });

  it('paridade: montar e parsear desfazem um ao outro, para todos os tipos', () => {
    // O mesmo raciocínio do `bigint` do advisory lock (AC-020): duas formas
    // de definir a mesma gramática é não ter nenhuma. Aqui o preço de
    // discordarem é imagem de uma empresa alcançável por outra.
    for (const tipo of TIPOS_CONHECIDOS) {
      const partes = { ...PARTES, tipo };
      const key = montarChave(partes);
      expect(key).not.toBeNull();
      const resultado = parsearChave(key);
      expect(resultado.valida).toBe(true);
      if (resultado.valida) {
        expect({
          companyId: resultado.chave.companyId,
          tipo: resultado.chave.tipo,
          recursoId: resultado.chave.recursoId,
          sha256: resultado.chave.sha256,
        }).toEqual(partes);
        expect(montarChave(resultado.chave)).toBe(key);
      }
    }
  });

  it('a visibilidade sai do TIPO, nunca do chamador', () => {
    expect(visibilidadeDe('quadra')).toBe('publico');
    expect(visibilidadeDe('logo')).toBe('publico');
    expect(visibilidadeDe('perfil')).toBe('privado');
    expect(visibilidadeDe('professor')).toBe('privado');
    // Foto de pessoa privada e mídia institucional pública: se algum tipo
    // mudar de lado, é decisão de produto e este teste tem de doer.
    expect(Object.keys(TIPOS_DE_MIDIA).sort()).toEqual([
      'logo',
      'perfil',
      'professor',
      'quadra',
    ]);
  });

  it('montarChave recusa parte malformada em vez de gerar chave inválida', () => {
    // Gerar uma chave que o próprio parser recusaria seria fabricar o objeto
    // órfão na origem: o upload grava, e a exclusão nunca acha.
    expect(montarChave({ ...PARTES, companyId: 'nao-e-uuid' })).toBeNull();
    expect(
      montarChave({ ...PARTES, recursoId: EMPRESA.toUpperCase() }),
    ).toBeNull();
    expect(montarChave({ ...PARTES, sha256: 'abc' })).toBeNull();
    expect(montarChave({ ...PARTES, tipo: 'inexistente' as never })).toBeNull();
  });
});

describe('o parser recusa, e diz de qual portão', () => {
  it.each([
    ['', 'chave ausente'],
    ['empresas', 'esperava 5 segmentos'],
    [`empresas/${EMPRESA}/quadra/${RECURSO}`, 'esperava 5 segmentos'],
    [
      `empresas/${EMPRESA}/quadra/${RECURSO}/${SHA}.webp/x`,
      'esperava 5 segmentos',
    ],
    [
      `outra/${EMPRESA}/quadra/${RECURSO}/${SHA}.webp`,
      'não começa por empresas/',
    ],
    [`empresas//quadra/${RECURSO}/${SHA}.webp`, 'company_id não é UUID'],
    [
      `empresas/${EMPRESA}/inexistente/${RECURSO}/${SHA}.webp`,
      'tipo de mídia desconhecido',
    ],
    [`empresas/${EMPRESA}/quadra/nao-uuid/${SHA}.webp`, 'recurso não é UUID'],
    [
      `empresas/${EMPRESA}/quadra/${RECURSO}/${SHA}.png`,
      'extensão não é .webp',
    ],
    [`empresas/${EMPRESA}/quadra/${RECURSO}/${SHA}`, 'extensão não é .webp'],
    [`empresas/${EMPRESA}/quadra/${RECURSO}/abc.webp`, 'não é um sha256'],
    [
      `empresas/${EMPRESA}/quadra/${RECURSO}/${'A'.repeat(64)}.webp`,
      'não é um sha256',
    ],
  ])('recusa %p', (key, motivo) => {
    const resultado = parsearChave(key);
    expect(resultado.valida).toBe(false);
    if (!resultado.valida) {
      expect(resultado.motivo).toContain(motivo);
    }
  });

  it('recusa UUID em MAIÚSCULAS, e é defesa e não implicância', () => {
    // Chave de objeto no S3 é case-sensitive: `.../A1B2/...` e `.../a1b2/...`
    // são dois objetos. Aceitar as duas formas criaria duas chaves para o
    // mesmo recurso — e o CHECK da fila, que compara com `company_id::text`
    // (minúsculo), recusaria a maiúscula na hora de enfileirar a exclusão,
    // deixando o objeto órfão no bucket para sempre.
    //
    // A validação cruzada de 2026-08-24 delegou a este parser a obrigação de
    // canonicalizar OU recusar. Recusa: canonicalizar em silêncio esconderia
    // de onde veio a chave errada.
    const maiuscula = `empresas/${EMPRESA.toUpperCase()}/quadra/${RECURSO}/${SHA}.webp`;
    expect(parsearChave(maiuscula).valida).toBe(false);
    expect(parsearChave(CHAVE.replace(SHA, SHA.toUpperCase())).valida).toBe(
      false,
    );
  });

  it.each([
    `empresas/${EMPRESA}/quadra/../${SHA}.webp`,
    `empresas/${EMPRESA}/../../etc/passwd`,
    `empresas/../${EMPRESA}/quadra/${SHA}.webp`,
    `empresas/${EMPRESA}/quadra/${RECURSO}/..%2F${SHA}.webp`,
    `empresas/${EMPRESA}/quadra/${RECURSO}/${SHA}.webp/../../x.webp`,
  ])('recusa travessia de caminho: %p', (key) => {
    // Não há regra própria contra `..`: o UUID canônico não tem ponto nem
    // barra, então a travessia morre no formato. Regra própria contra `..`
    // seria uma blocklist, e blocklist protege só do que se conhece.
    expect(parsearChave(key).valida).toBe(false);
  });

  it.each([[null], [undefined], [42], [{}], [[]], [Buffer.from(CHAVE)]])(
    'recusa entrada que nem é string: %p',
    (key) => {
      expect(() => parsearChave(key)).not.toThrow();
      expect(parsearChave(key).valida).toBe(false);
    },
  );
});

describe('conferirChave — a segunda camada (AC-018/INV-037)', () => {
  const esperado = {
    companyId: EMPRESA,
    tipo: 'quadra',
    recursoId: RECURSO,
  } as const;

  it('aceita a chave que bate com o recurso', () => {
    expect(conferirChave(CHAVE, esperado).valida).toBe(true);
  });

  it('recusa chave de OUTRA empresa — o caso da chave adulterada no banco', () => {
    // O prefixo e o escopo por token leem o mesmo token e concordariam. Se o
    // dado no banco estiver errado, só esta comparação percebe.
    const alheia = `empresas/${OUTRA_EMPRESA}/quadra/${RECURSO}/${SHA}.webp`;
    const resultado = conferirChave(alheia, esperado);
    expect(resultado).toMatchObject({ valida: false });
    if (!resultado.valida) {
      expect(resultado.motivo).toBe('chave de outra empresa');
    }
  });

  it('recusa chave de outro recurso da MESMA empresa', () => {
    const outra = `empresas/${EMPRESA}/quadra/${OUTRO_RECURSO}/${SHA}.webp`;
    expect(conferirChave(outra, esperado).valida).toBe(false);
  });

  it('recusa chave de outro TIPO, mesmo com empresa e recurso certos', () => {
    const perfil = `empresas/${EMPRESA}/perfil/${RECURSO}/${SHA}.webp`;
    expect(conferirChave(perfil, esperado).valida).toBe(false);
  });

  it('recusa regime público pedido para tipo privado', () => {
    // É por aqui que foto de aluno viraria URL permanente de CDN.
    const foto = `empresas/${EMPRESA}/perfil/${RECURSO}/${SHA}.webp`;
    const resultado = conferirChave(foto, {
      companyId: EMPRESA,
      tipo: 'perfil',
      recursoId: RECURSO,
      visibilidade: 'publico',
    });
    expect(resultado).toMatchObject({ valida: false });
    if (!resultado.valida) {
      expect(resultado.motivo).toBe('regime de visibilidade não é o do tipo');
    }
  });

  it('aceita quando o regime pedido bate', () => {
    expect(
      conferirChave(`empresas/${EMPRESA}/perfil/${RECURSO}/${SHA}.webp`, {
        companyId: EMPRESA,
        tipo: 'perfil',
        recursoId: RECURSO,
        visibilidade: 'privado',
      }).valida,
    ).toBe(true);
  });
});

describe('fuzz — o parser é total (AC-019)', () => {
  // Gerador determinístico: sem `Math.random()`, senão uma falha não
  // reproduz. O corpus é grande o bastante para varrer os estados do parser
  // e pequeno o bastante para rodar em milissegundos.
  function* mutacoes(base: string): Generator<string> {
    const venenos = [
      '',
      '/',
      '//',
      '..',
      '../',
      '.',
      '\\',
      ' ',
      '�',
      '%2e%2e',
      ' ',
      '\n',
      'é',
      '𝟘',
      'A',
      'x'.repeat(300),
    ];
    for (const veneno of venenos) {
      yield veneno;
      yield base + veneno;
      yield veneno + base;
      for (let i = 0; i <= base.length; i += 3) {
        yield base.slice(0, i) + veneno + base.slice(i);
        yield base.slice(0, i) + veneno + base.slice(i + 1);
      }
    }
    for (let i = 0; i < base.length; i += 3) {
      yield base.slice(0, i) + base.slice(i + 1); // deleta um caractere
      yield base.slice(0, i); // trunca
    }
  }

  it('não lança para nenhuma mutação, e só aceita o que é idêntico ao original', () => {
    let testadas = 0;
    let aceitas = 0;
    for (const key of mutacoes(CHAVE)) {
      testadas++;
      let resultado: ReturnType<typeof parsearChave> | null = null;
      expect(() => {
        resultado = parsearChave(key);
      }).not.toThrow();
      const decidido = resultado as ReturnType<typeof parsearChave> | null;
      if (decidido?.valida) {
        aceitas++;
        // Aceitou: então tem de ser reconstruível byte a byte. Uma chave
        // aceita que não volta a si mesma é uma chave que aponta para outro
        // objeto — o defeito silencioso que a paridade existe para pegar.
        expect(montarChave(decidido.chave)).toBe(key);
      }
    }
    expect(testadas).toBeGreaterThan(1000);
    // A única mutação que pode ser aceita é a que reconstrói a chave
    // original (inserir '' em qualquer posição).
    expect(aceitas).toBeGreaterThan(0);
  });

  it('não lança nem aceita nada em entradas hostis diretas', () => {
    const hostis = [
      'empresas/'.repeat(200),
      `empresas/${EMPRESA}/quadra/${RECURSO}/${'a'.repeat(65)}.webp`,
      `empresas/${EMPRESA}/quadra/${RECURSO}/${'a'.repeat(63)}.webp`,
      `empresas/${EMPRESA}/quadra/${RECURSO}/${SHA}.webp .png`,
      `empresas/${EMPRESA}/QUADRA/${RECURSO}/${SHA}.webp`,
      `empresas/${EMPRESA}/quadra /${RECURSO}/${SHA}.webp`,
      `EMPRESAS/${EMPRESA}/quadra/${RECURSO}/${SHA}.webp`,
      ` empresas/${EMPRESA}/quadra/${RECURSO}/${SHA}.webp`,
      `empresas/${EMPRESA}/quadra/${RECURSO}/${SHA}.webp `,
    ];
    for (const key of hostis) {
      expect(() => parsearChave(key)).not.toThrow();
      expect(parsearChave(key).valida).toBe(false);
    }
  });

  it('o motivo da recusa nunca carrega a chave inteira', () => {
    // O motivo vai para log. A chave carrega company_id e o id do recurso —
    // não é dado pessoal, mas também não precisa estar lá, e a AC-019 pede
    // log sem dado pessoal.
    for (const key of mutacoes(CHAVE)) {
      const resultado = parsearChave(key);
      if (!resultado.valida && key.length > 20) {
        expect(resultado.motivo).not.toContain(key);
        expect(resultado.motivo).not.toContain(EMPRESA);
      }
    }
  });
});
