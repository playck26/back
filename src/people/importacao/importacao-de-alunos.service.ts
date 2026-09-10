import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import type { Prisma } from '@prisma/client';
import {
  BCRYPT_COST,
  gerarSenhaTemporaria,
  senhaTemporariaExpiraEm,
} from '../../common/utils/senha-temporaria';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizarNascimento } from '../normalizar-nascimento';
import { linhasComNumero } from './csv';
import type {
  ErroDeImportacaoDto,
  RelatorioDeImportacaoDto,
} from './dto/importacao-response.dto';

/**
 * As colunas aceitas. **`nome` e `email` são os únicos obrigatórios** (D9): o
 * resto é o cadastro da SPEC-036, que não bloqueia nada. Importar 300 alunos
 * com nome e e-mail é um estado legítimo — eles nascem com 29% de completude e
 * a faixa do app pede o resto.
 */
const COLUNAS = [
  'nome',
  'email',
  'telefone',
  'dataNascimento',
  'emergenciaNome',
  'emergenciaTelefone',
  'nivel',
] as const;

type Coluna = (typeof COLUNAS)[number];

/**
 * Aceita o cabeçalho como o gestor o escreveria.
 *
 * *Não é gentileza:* `data de nascimento` com espaços e acento é o que sai de
 * qualquer planilha feita à mão, e recusá-lo transformaria o primeiro uso numa
 * caça ao nome exato da coluna.
 */
const APELIDOS: Record<string, Coluna> = {
  nome: 'nome',
  email: 'email',
  'e-mail': 'email',
  telefone: 'telefone',
  celular: 'telefone',
  datanascimento: 'dataNascimento',
  'data de nascimento': 'dataNascimento',
  nascimento: 'dataNascimento',
  emergencianome: 'emergenciaNome',
  'contato de emergencia': 'emergenciaNome',
  emergenciatelefone: 'emergenciaTelefone',
  'telefone de emergencia': 'emergenciaTelefone',
  nivel: 'nivel',
};

/** Sem acento, sem caixa, sem espaço nas pontas — para casar apelido. */
function normalizarCabecalho(bruto: string): string {
  return bruto.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * SPEC-038 — **importar alunos por planilha.**
 *
 * ## Dois passos, e a razão é o custo do engano (D2/D3)
 *
 * `conferir=true` valida e **não escreve**; sem ele, valida e escreve — e
 * qualquer erro recusa o arquivo **inteiro**.
 *
 * *Importar as boas e listar as ruins foi considerado e recusado:* deixaria o
 * gestor sem saber quais das 300 entraram, e a segunda tentativa duplicaria o
 * que já passou. Com o passo de conferência, o custo do "tudo ou nada" é zero:
 * ele confere, corrige o arquivo, importa.
 *
 * ## O relatório é por LINHA, com o número da PLANILHA (D4)
 *
 * *"O e-mail da linha 47 já existe"* é acionável; *"há e-mails repetidos"* não
 * é. E o número conta o cabeçalho, porque é o que aparece no Excel.
 */
/**
 * **Os `code` sao LITERAIS, e nao constantes exportadas.**
 *
 * Parece pior e nao e: o gate `Docs/contrato-spec-x-codigo.py` casa o campo
 * `code` seguido de uma string literal, e confronta com o que a spec PROMETE.
 * Atras de uma constante, o codigo existe e o gate nao o ve -- e ele reprova a
 * spec dizendo "ramo morto no frontend" sobre algo que funciona.
 *
 * Foi assim que esta spec reprovou na primeira execucao do gate. E a SEGUNDA
 * reprovacao foi do comentario que explicava a primeira: ele trazia o padrao
 * escrito por extenso, e o gate o leu como um codigo chamado `X`. Escrever a
 * regra sem escrever a forma dela e o conserto.
 */
@Injectable()
export class ImportacaoDeAlunosService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lê o cabeçalho e devolve o mapa `coluna -> índice`.
   *
   * **Coluna desconhecida é ERRO, não silêncio** (D8). Ignorá-la é como uma
   * planilha com `e-mail` mal escrito é importada com todos os e-mails
   * vazios — e o gestor só descobre quando ninguém consegue entrar.
   */
  private lerCabecalho(campos: string[]): Record<Coluna, number> {
    const mapa = {} as Record<Coluna, number>;
    const desconhecidas: string[] = [];

    campos.forEach((bruto, indice) => {
      const chave = normalizarCabecalho(bruto);
      if (chave === '') return;
      const coluna = APELIDOS[chave];
      if (!coluna) {
        desconhecidas.push(bruto.trim());
        return;
      }
      mapa[coluna] = indice;
    });

    if (desconhecidas.length > 0) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'COLUNA_DESCONHECIDA',
        message: `Coluna não reconhecida: ${desconhecidas.join(', ')}. As aceitas são: ${COLUNAS.join(', ')}.`,
        colunas: desconhecidas,
      });
    }
    if (mapa.nome === undefined || mapa.email === undefined) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'PLANILHA_SEM_CABECALHO',
        message:
          'A primeira linha precisa ser o cabeçalho, com pelo menos as colunas `nome` e `email`.',
      });
    }
    return mapa;
  }

  /**
   * Valida tudo e devolve o relatório. **Não escreve nunca** — quem escreve é
   * o `importar`, e só depois de chamar isto e receber zero erros.
   */
  async conferir(
    companyId: string,
    conteudo: string,
  ): Promise<RelatorioDeImportacaoDto> {
    const linhas = linhasComNumero(conteudo);
    if (linhas.length === 0) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'PLANILHA_SEM_CABECALHO',
        message: 'O arquivo está vazio.',
      });
    }

    const mapa = this.lerCabecalho(linhas[0].campos);
    const dados = linhas.slice(1);
    if (dados.length === 0) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'PLANILHA_VAZIA',
        message:
          'A planilha tem cabeçalho e nenhuma linha de aluno. Importar zero alunos com sucesso seria uma resposta verdadeira e inútil.',
      });
    }

    const niveis = await this.prisma.nivel.findMany({
      where: { companyId },
      select: { id: true, nome: true },
    });
    const porNome = new Map(
      niveis.map((n) => [normalizarCabecalho(n.nome), n]),
    );

    const erros: ErroDeImportacaoDto[] = [];
    /** e-mail -> a PRIMEIRA linha em que ele apareceu (AC-008). */
    const vistos = new Map<string, number>();
    const validas: {
      linha: number;
      nome: string;
      email: string;
      telefone: string | null;
      dataNascimento: Date | null;
      emergenciaNome: string | null;
      emergenciaTelefone: string | null;
      nivelId: string | null;
    }[] = [];

    const emailsDoArquivo: string[] = [];
    for (const { campos } of dados) {
      const e = (campos[mapa.email] ?? '').trim().toLowerCase();
      if (e !== '') emailsDoArquivo.push(e);
    }
    /**
     * **Uma consulta para todos os e-mails, e não uma por linha.**
     *
     * Uma planilha de 300 alunos viraria 300 idas ao banco — o mesmo N+1 que
     * o DEF-013 baniu três vezes neste projeto, e que voltou pelo caminho de
     * escrita na terceira.
     */
    const jaExistem = new Set(
      (
        await this.prisma.usuario.findMany({
          where: { email: { in: emailsDoArquivo } },
          select: { email: true },
        })
      ).map((u) => u.email.toLowerCase()),
    );

    for (const { numero, campos } of dados) {
      const valor = (c: Coluna): string =>
        mapa[c] === undefined ? '' : (campos[mapa[c]] ?? '').trim();
      const erro = (coluna: string, mensagem: string) =>
        erros.push({ linha: numero, coluna, mensagem });

      const nome = valor('nome');
      const email = valor('email').toLowerCase();

      if (nome === '') erro('nome', 'O nome é obrigatório.');
      if (email === '') {
        erro('email', 'O e-mail é obrigatório.');
      } else if (!EMAIL.test(email)) {
        erro('email', `"${email}" não parece um e-mail.`);
      } else if (vistos.has(email)) {
        // AC-008: o erro vai na SEGUNDA ocorrência e cita a primeira — sem a
        // linha de origem, o gestor procura a duplicata no arquivo inteiro.
        erro(
          'email',
          `Este e-mail já aparece na linha ${vistos.get(email) as number}.`,
        );
      } else if (jaExistem.has(email)) {
        erro('email', 'Já existe uma conta com este e-mail.');
      } else {
        vistos.set(email, numero);
      }

      let dataNascimento: Date | null = null;
      const nascimentoBruto = valor('dataNascimento');
      if (nascimentoBruto !== '') {
        try {
          // **A MESMA regra da SPEC-036, num lugar só.** Reimplementar aqui
          // criaria uma segunda verdade sobre datas plausíveis, e a primeira
          // a divergir seria esta — que ninguém olha depois de importar.
          dataNascimento = normalizarNascimento(nascimentoBruto) ?? null;
        } catch {
          erro(
            'dataNascimento',
            `"${nascimentoBruto}" precisa ser AAAA-MM-DD, existir no calendário, ser posterior a 1900 e não estar no futuro.`,
          );
        }
      }

      let nivelId: string | null = null;
      const nivelBruto = valor('nivel');
      if (nivelBruto !== '') {
        const achado = porNome.get(normalizarCabecalho(nivelBruto));
        if (!achado) {
          erro(
            'nivel',
            niveis.length === 0
              ? `O nível "${nivelBruto}" não existe — este clube ainda não tem níveis cadastrados.`
              : `O nível "${nivelBruto}" não existe. Os cadastrados são: ${niveis.map((n) => n.nome).join(', ')}.`,
          );
        } else {
          nivelId = achado.id;
        }
      }

      const temErroNestaLinha = erros.some((x) => x.linha === numero);
      if (!temErroNestaLinha) {
        validas.push({
          linha: numero,
          nome,
          email,
          telefone: valor('telefone') || null,
          dataNascimento,
          emergenciaNome: valor('emergenciaNome') || null,
          emergenciaTelefone: valor('emergenciaTelefone') || null,
          nivelId,
        });
      }
    }

    return {
      total: dados.length,
      validas: validas.length,
      erros,
      linhas: validas,
    };
  }

  /**
   * SPEC-038/REQ-003 — a escrita, **tudo ou nada** (INV-117).
   *
   * Com qualquer erro, `422` com o relatório e **nada é escrito**. O lote
   * inteiro numa `$transaction`: metade importada é o estado que ninguém
   * consegue consertar sem saber qual metade.
   */
  async importar(
    companyId: string,
    conteudo: string,
  ): Promise<{
    criados: {
      linha: number;
      alunoId: string;
      email: string;
      senhaTemporaria: string;
    }[];
  }> {
    const relatorio = await this.conferir(companyId, conteudo);
    if (relatorio.erros.length > 0) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'PLANILHA_COM_ERROS',
        message: `A planilha tem ${relatorio.erros.length} problema(s). Nada foi importado — corrija e envie de novo.`,
        ...relatorio,
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const criados: {
        linha: number;
        alunoId: string;
        email: string;
        senhaTemporaria: string;
      }[] = [];

      for (const linha of relatorio.linhas) {
        // **As MESMAS funções do cadastro individual**, e não uma cópia: a
        // validade e o custo do bcrypt são regra de segurança, e duas
        // implementações divergem no primeiro ajuste.
        const senha = gerarSenhaTemporaria();
        const hash = await bcrypt.hash(senha, BCRYPT_COST);
        const expiraEm = senhaTemporariaExpiraEm();
        const usuario = await tx.usuario.create({
          data: {
            email: linha.email,
            senhaHash: hash,
            nome: linha.nome,
            telefone: linha.telefone,
            role: 'aluno',
            companyId,
            // INV-008 força a troca no primeiro acesso — a mesma regra do
            // cadastro individual, e a razão de a senha poder sair na
            // resposta uma única vez.
            senhaTemporaria: true,
            senhaTemporariaExpiraEm: expiraEm,
          },
          select: { id: true, email: true },
        });
        const aluno = await tx.aluno.create({
          data: {
            usuarioId: usuario.id,
            companyId,
            nivelId: linha.nivelId,
            // Foi o CLUBE que trouxe estas pessoas: elas não pedem para
            // entrar, já entraram. Mesmo raciocínio do convite (AC-014).
            vinculo: 'aprovado',
            dataNascimento: linha.dataNascimento,
            emergenciaNome: linha.emergenciaNome,
            emergenciaTelefone: linha.emergenciaTelefone,
          },
          select: { id: true },
        });
        criados.push({
          linha: linha.linha,
          alunoId: aluno.id,
          email: usuario.email,
          senhaTemporaria: senha,
        });
      }

      return { criados };
    });
  }
}

export type TransacaoDeImportacao = Prisma.TransactionClient;
