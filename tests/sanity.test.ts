import { describe, expect, it } from "vitest";

// Placeholder de B2: evita que `vitest run` y `tsc` fallen sin entradas.
// B3 lo deja atrás con `wire.test.ts`; se puede borrar entonces.
describe("bootstrap", () => {
  it("el toolchain corre", () => {
    expect(1 + 1).toBe(2);
  });
});
