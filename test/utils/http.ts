import type { Response } from 'supertest';

// supertest tipa `Response.body` como `any` — este helper concentra o
// `as` num único lugar por chamada, evitando acesso "unsafe" espalhado
// pelos testes (@typescript-eslint/no-unsafe-member-access).
export function bodyOf<T>(res: Response): T {
  return res.body as T;
}
