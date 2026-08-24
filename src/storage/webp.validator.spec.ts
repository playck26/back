import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LIMITE_DE_DIMENSAO_PX,
  MOTIVO_ILEGIVEL,
  validarWebp,
  type ResultadoDaValidacao,
} from './webp.validator';

// SPEC-017/TASK-002 — o validador de WebP.
//
// **O corpus veio antes deste arquivo, e este arquivo veio antes do
// validador.** É a ordem que a spec pede, e a razão está nela: validador
// escrito primeiro acaba testado contra o que ele já faz.
//
// O corpus é binário commitado, em `test/fixtures/webp/` — ver o README de
// lá para o que cada arquivo é. Nada aqui decodifica imagem (INV-033).

const CORPUS = join(__dirname, '..', '..', 'test', 'fixtures', 'webp');

function ler(nome: string): Buffer {
  return readFileSync(join(CORPUS, nome));
}

function validar(nome: string): ResultadoDaValidacao {
  return validarWebp(ler(nome));
}

describe('validarWebp', () => {
  describe('válidos — precisam passar', () => {
    it.each([
      ['valido-vp8-lossy.webp', 'VP8', 64, 48],
      ['valido-vp8l-lossless.webp', 'VP8L', 64, 48],
      ['valido-vp8x-com-alpha.webp', 'VP8X', 64, 48],
    ] as const)('aceita %s e lê %s %ix%i', (nome, formato, largura, altura) => {
      expect(validar(nome)).toEqual({
        valido: true,
        formato,
        largura,
        altura,
      });
    });

    it('aceita VP8 com os bits de ESCALA ligados, lendo só os 14 de dimensão', () => {
      // Os 2 bits altos do campo são escala de exibição, não dimensão. Quem
      // lê os 16 bits inteiros vê 49216 e recusa uma imagem de 64px.
      // Os dois eixos: a máscara é por campo, e errar só a da altura
      // sobreviveu à primeira bateria de mutação.
      expect(validar('valido-vp8-com-bits-de-escala.webp')).toEqual({
        valido: true,
        formato: 'VP8',
        largura: 64,
        altura: 48,
      });
    });

    it('aceita exatamente 2500px — a fronteira da AC-004 é inclusiva', () => {
      const resultado = validar('valido-2500px-no-limite.webp');
      expect(resultado).toMatchObject({ valido: true, largura: 2500 });
      expect(LIMITE_DE_DIMENSAO_PX).toBe(2500);
    });
  });

  describe('AC-001 — só WebP, e pelos BYTES', () => {
    it.each([
      'jpeg-valido.jpg',
      'png-valido.png',
      'gif-valido.gif',
      'bmp-valido.bmp',
      'bytes-aleatorios.bin',
      'webp-riff-sem-webp.webp',
      // `WEBP` no lugar certo, mas o magic é `RIFX`. Existe porque a
      // mutação que apagava a checagem do `RIFF` SOBREVIVEU ao corpus
      // original: todo arquivo de lá também falhava no `WEBP`.
      'webp-magic-trocado.webp',
    ])('recusa %s com TIPO_NAO_SUPORTADO', (nome) => {
      expect(validar(nome)).toMatchObject({
        valido: false,
        codigo: 'TIPO_NAO_SUPORTADO',
      });
    });

    it('recusa JPEG com nome e extensão de WebP — é a AC-001 inteira', () => {
      expect(validar('jpeg-disfarcado-de.webp')).toMatchObject({
        valido: false,
        codigo: 'TIPO_NAO_SUPORTADO',
      });
    });
  });

  describe('AC-002 — allowlist de chunks, não blocklist', () => {
    it.each([
      ['webp-com-exif.webp', 'EXIF — é o GPS da foto tirada na quadra'],
      ['webp-com-xmp.webp', 'XMP'],
      ['webp-com-iccp.webp', 'ICCP'],
    ])('recusa %s (%s)', (nome) => {
      expect(validar(nome)).toMatchObject({
        valido: false,
        codigo: 'IMAGEM_COM_METADADOS',
      });
    });

    it('recusa chunk DESCONHECIDO — o caso que a blocklist não pega', () => {
      // Blocklist protege do que se conhece; allowlist, do que não se
      // conhece. O formato permite chunk customizado com dado arbitrário.
      expect(validar('webp-com-chunk-desconhecido.webp')).toMatchObject({
        valido: false,
        codigo: 'IMAGEM_COM_METADADOS',
      });
    });

    it('recusa FourCC de caixa errada (`vp8 ` não é `VP8 `)', () => {
      expect(validar('webp-com-chunk-minusculo.webp')).toMatchObject({
        valido: false,
        codigo: 'IMAGEM_COM_METADADOS',
      });
    });
  });

  describe('sequência de chunks — o BLOQUEADOR da validação cruzada', () => {
    // A allowlist responde QUAIS chunks. Não respondia QUANTOS nem EM QUE
    // ORDEM, e o revisor independente montou um `VP8 ` válido seguido de um
    // segundo `VP8L` com 41 bytes de carga arbitrária: todos os FourCC na
    // allowlist, dimensão lida do primeiro, veredito `valido: true`.
    //
    // Nenhuma das 22 mutações tinha achado, e a lição é essa: mutação prova
    // que os testes matam o código que você ESCREVEU. Não diz nada sobre o
    // código que você esqueceu de escrever.

    it('recusa carga arbitrária num VP8L extra depois da imagem', () => {
      const resultado = validar('webp-carga-em-vp8l-extra.webp');
      expect(resultado).toMatchObject({
        valido: false,
        codigo: 'IMAGEM_COM_METADADOS',
      });
      if (!resultado.valido) {
        expect(resultado.motivo).toMatch(/além da imagem/);
        expect(resultado.motivo).not.toContain('CARGA ARBITRARIA');
      }
    });

    it('recusa a mesma carga num ALPH extra', () => {
      expect(validar('webp-carga-em-alph-extra.webp')).toMatchObject({
        valido: false,
        codigo: 'IMAGEM_COM_METADADOS',
      });
    });

    it.each([
      ['webp-alph-depois-da-imagem.webp', 'ALPH depois da imagem'],
      ['webp-alph-sem-vp8x.webp', 'ALPH fora do container estendido'],
      ['webp-dois-vp8x.webp', 'VP8X duplicado'],
      ['webp-dois-alph.webp', 'ALPH duplicado'],
      ['webp-vp8x-sem-imagem.webp', 'VP8X e ALPH sem chunk de imagem'],
      ['webp-alph-antes-do-vp8x.webp', 'ALPH antes do VP8X'],
      ['webp-alph-com-vp8l.webp', 'ALPH junto de VP8L, que já tem alpha'],
    ])('recusa %s (%s)', (nome) => {
      expect(validar(nome).valido).toBe(false);
    });

    it('mas aceita VP8X embrulhando um VP8L, que é sequência legal', () => {
      // A regra nova não pode virar recusa de imagem legítima: o container
      // estendido sem ALPH é forma válida do formato.
      expect(validar('valido-vp8x-com-vp8l.webp')).toMatchObject({
        valido: true,
        formato: 'VP8X',
      });
    });
  });

  describe('AC-003 — animação, por chunk e por FLAG', () => {
    it('recusa WebP animado de verdade (ANIM + ANMF)', () => {
      expect(validar('webp-animado.webp')).toMatchObject({
        valido: false,
        codigo: 'IMAGEM_COM_METADADOS',
      });
    });

    it('recusa o bit de animação do VP8X mesmo SEM chunk ANIM', () => {
      // O arquivo tem só VP8X/ALPH/VP8 — todos da allowlist. Quem varre
      // chunk e ignora o flag deixa este passar.
      expect(validar('webp-vp8x-bit-de-animacao.webp')).toMatchObject({
        valido: false,
        codigo: 'IMAGEM_COM_METADADOS',
      });
    });
  });

  describe('AC-004 — dimensão, lida do cabeçalho', () => {
    it.each([
      'webp-2501px-largura.webp',
      'webp-2501px-altura.webp',
      'webp-vp8x-2501px.webp',
    ])('recusa %s com IMAGEM_GRANDE_DEMAIS', (nome) => {
      expect(validar(nome)).toMatchObject({
        valido: false,
        codigo: 'IMAGEM_GRANDE_DEMAIS',
      });
    });
  });

  describe('AC-005 — quebrado recusa sem crash', () => {
    it.each([
      'webp-vazio.webp',
      'webp-cabecalho-cortado.webp',
      'webp-so-cabecalho-riff.webp',
      'webp-truncado-no-meio.webp',
      'webp-riff-mentindo-tamanho.webp',
      'webp-chunk-mentindo-tamanho.webp',
      // Payload declarado maior que o arquivo, com tamanho PAR: é o caso
      // que separa a guarda de limite da leniência de padding. Sem a
      // guarda, este arquivo truncado passaria como válido.
      'webp-chunk-grande-par.webp',
      // VP8X declarando 12 bytes de payload em vez dos 10 do formato.
      // Terceira mutação sobrevivente do ciclo: sem este arquivo, apagar
      // a checagem de tamanho do VP8X não reprovava nada.
      'webp-vp8x-tamanho-errado.webp',
      // Cabeçalho de codec adulterado: sync code do VP8, frame que não é
      // keyframe, assinatura 0x2F do VP8L. Os três vieram de mutação
      // sobrevivente — sem eles, apagar cada checagem não reprovava nada.
      'webp-vp8-sync-quebrado.webp',
      'webp-vp8-nao-keyframe.webp',
      'webp-vp8l-assinatura-errada.webp',
      // RIFF/WEBP bem formados e nenhum chunk depois — chega até a
      // contagem, ao contrário do de 12 bytes cortado, que morre antes no
      // tamanho declarado do RIFF.
      'webp-sem-chunk-nenhum.webp',
      // Largura zerada nos 14 bits: cabeçalho legível, imagem degenerada.
      'webp-vp8-largura-zero.webp',
      // Chunk VP8 de 8 bytes: sync intacto, dimensão cortada ao meio. É o
      // arquivo que faz um parser sem checagem de tamanho ler fora do
      // buffer — e o teste do cinto de segurança, logo abaixo, é quem
      // percebe que foi isso que aconteceu.
      'webp-vp8-chunk-curto.webp',
    ])('recusa %s sem lançar', (nome) => {
      const resultado = validar(nome);
      expect(resultado.valido).toBe(false);
    });

    it('nunca lança, para nenhum arquivo do corpus', () => {
      // O validador é TOTAL. Exceção aqui viraria 500 numa rota que deveria
      // responder 422 — caminho novo de falha, e o que a AC-005 proíbe.
      const nomes = [
        'valido-vp8-lossy.webp',
        'webp-vazio.webp',
        'webp-chunk-mentindo-tamanho.webp',
        'bytes-aleatorios.bin',
        'jpeg-disfarcado-de.webp',
      ];
      for (const nome of nomes) {
        expect(() => validar(nome)).not.toThrow();
      }
    });
  });

  describe('o cinto de segurança nunca é acionado', () => {
    // `validarWebp` tem um `catch` de último recurso. Ele existe para o
    // fail-closed, mas **não pode ser a defesa que está funcionando**:
    // enquanto ele apara exceção, toda checagem removida continua
    // "recusando", e mutação nenhuma reprova.
    //
    // Este teste foi escrito depois de três mutações sobreviverem
    // exatamente assim. É ele que torna as checagens de limite
    // load-bearing.
    const arquivos = readdirSync(CORPUS).filter(
      (nome) => !nome.endsWith('.py') && !nome.endsWith('.md'),
    );

    it.each(arquivos)('%s é decidido pelo parser, não pelo catch', (nome) => {
      const resultado = validar(nome);
      if (!resultado.valido) {
        expect(resultado.motivo).not.toBe(MOTIVO_ILEGIVEL);
      }
    });

    it('o corpus tem os arquivos que os testes citam', () => {
      // Fixture some sem ninguém notar quando o teste só lê por nome.
      expect(arquivos.length).toBeGreaterThanOrEqual(30);
    });
  });

  describe('a recusa diz de qual portão veio', () => {
    it.each([
      ['webp-vazio.webp', /arquivo vazio/],
      ['webp-cabecalho-cortado.webp', /cabeçalho RIFF/],
      ['webp-sem-chunk-nenhum.webp', /nenhum chunk/],
      ['webp-riff-mentindo-tamanho.webp', /tamanho declarado no RIFF/],
      ['webp-vp8x-tamanho-errado.webp', /VP8X com tamanho errado/],
      ['webp-vp8-largura-zero.webp', /dimensão inválida/],
      // Os quatro abaixo entraram porque a mutação correspondente
      // SOBREVIVEU olhando só o `codigo`: outro portão pegava o arquivo
      // antes, com o mesmo código, e a checagem removida não fazia falta
      // nenhuma. Motivo é saída real — vai para log — e é o que separa
      // "foi recusado" de "foi recusado POR ISTO".
      ['webp-dois-vp8x.webp', /sem chunk de imagem na posição esperada/],
      ['webp-vp8x-sem-imagem.webp', /sem chunk de imagem na posição esperada/],
      ['webp-alph-antes-do-vp8x.webp', /ALPH fora do container estendido/],
      ['webp-com-chunk-minusculo.webp', /chunk não permitido: vp8/],
    ])('%s recusa pelo motivo certo', (nome, esperado) => {
      const resultado = validar(nome);
      expect(resultado.valido).toBe(false);
      if (!resultado.valido) {
        expect(resultado.motivo).toMatch(esperado);
      }
    });
  });

  describe('fuzz — nenhuma entrada faz o validador lançar', () => {
    it('não lança em nenhum prefixo de um arquivo válido', () => {
      // Truncar byte a byte cobre todo estado intermediário do parser:
      // acabar no meio do FourCC, no meio do tamanho, no meio do payload.
      const completo = ler('valido-vp8x-com-alpha.webp');
      for (let corte = 0; corte <= completo.length; corte++) {
        const pedaco = completo.subarray(0, corte);
        expect(() => validarWebp(pedaco)).not.toThrow();
        if (corte < completo.length) {
          expect(validarWebp(pedaco).valido).toBe(false);
        }
      }
    });

    it('não lança com um byte corrompido em qualquer posição do cabeçalho', () => {
      const completo = ler('valido-vp8x-com-alpha.webp');
      for (let i = 0; i < Math.min(completo.length, 40); i++) {
        for (const valor of [0x00, 0xff, 0x80]) {
          const mutado = Buffer.from(completo);
          mutado[i] = valor;
          expect(() => validarWebp(mutado)).not.toThrow();
        }
      }
    });

    it('não lança com buffer vazio nem com lixo curto', () => {
      for (const entrada of [
        Buffer.alloc(0),
        Buffer.from('R'),
        Buffer.from('RIFF'),
        Buffer.from('RIFF\xff\xff\xff\xffWEBP', 'latin1'),
        Buffer.alloc(64, 0xff),
      ]) {
        expect(() => validarWebp(entrada)).not.toThrow();
        expect(validarWebp(entrada).valido).toBe(false);
      }
    });
  });

  describe('o motivo da recusa não vaza conteúdo', () => {
    it('não devolve bytes do arquivo no motivo', () => {
      // A recusa vira log e resposta HTTP. Ecoar payload de um chunk
      // desconhecido seria escrever no log exatamente o dado arbitrário
      // que a allowlist existe para recusar.
      const resultado = validar('webp-com-chunk-desconhecido.webp');
      expect(resultado.valido).toBe(false);
      if (!resultado.valido) {
        expect(resultado.motivo).not.toContain('carga arbitraria');
      }
    });
  });
});
