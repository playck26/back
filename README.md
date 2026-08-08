# PlayCK — Back

API do PlayCK (NestJS + Prisma + PostgreSQL). Monólito modular único —
único repositório com acesso direto ao banco (ver `DATA_MODEL.md` e
`TARGET_ARCHITECTURE.md` no repositório de documentação).

## Setup local

```bash
pnpm install
cp .env.example .env   # ajustar DATABASE_URL depois que o Neon existir
pnpm run openapi:export  # gera openapi.json sem precisar de banco
pnpm run start:dev
```

`PrismaService` conecta de forma lazy (na 1ª query) — a aplicação sobe e
expõe `/api/docs` mesmo sem `DATABASE_URL` válido. Rotas que tocam o banco
só funcionam depois que o Neon estiver provisionado e a migration
aplicada (`pnpm run db:migrate:deploy`).

## Scripts

| Script | O que faz |
|---|---|
| `start:dev` | Sobe a API com watch |
| `build` | Compila para `dist/` |
| `lint` / `lint:ci` | ESLint (`lint` corrige automaticamente, `lint:ci` só valida) |
| `typecheck` | `tsc --noEmit` |
| `test` | Testes unitários (Jest) |
| `openapi:export` | Gera `openapi.json` (contrato consumido pelos 3 frontends — ADR-001), sem subir porta nem tocar o banco |
| `db:migrate:dev` / `db:migrate:deploy` | Roda migration do Prisma |
| `db:seed` | Popula dado de desenvolvimento (`prisma/seed.ts`, incremental por spec — ver `DATA_MODEL.md`) |

## Contrato de API

`openapi.json` (raiz deste repositório) é gerado por `pnpm run
openapi:export` e consumido pelos repositórios `admin`, `cliente` e
`sadmin` via `openapi-typescript` — nenhum pacote npm compartilhado entre
os 4 repositórios (poly-repo, ADR-001). Regenerar sempre que a API mudar.
