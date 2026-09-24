/**
 * **A porta de entrada, e ela não carrega lógica.**
 *
 * SPEC-071/TASK-001. Este arquivo tinha o corpo inteiro do arranque, e nenhum
 * teste o importava — o que vinha depois de `criarAppDeProducao()` ficava sem
 * prova. O corpo foi para `bootstrap.ts`, que uma suíte executa; aqui ficaram
 * **duas instruções**, e a `AC-006` as afirma por AST: um import **nomeado** de
 * `bootstrap` vindo de `./bootstrap`, e a chamada. **Nenhum terceiro statement,
 * e nenhum import lateral** (`import './algo'`) — comentário e formatação são
 * livres.
 *
 * **Por que não `if (require.main === module)`:** guardar a chamada mexeria em
 * como `node dist/main` arranca, e erro ali é produção que não sobe. O módulo
 * separado não toca no arranque — a chamada de topo continua aqui, com a mesma
 * semântica, e o `nest-cli.json` continua entrando por `main`.
 *
 * **A fresta que sobra são estas duas linhas**, cobertas por texto e não por
 * execução. Ela é pequena o bastante para uma revisão humana — o corpo inteiro
 * do `bootstrap()` não era.
 */
import { bootstrap } from './bootstrap';

void bootstrap();
