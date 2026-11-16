import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");

// Compila de verdad (tsc): da margen al timeout.
describe("pnpm build (artefacto de Lambda)", () => {
  it("genera dist/ ESM con package.json type=module y los dos handlers exportados", async () => {
    execFileSync("pnpm", ["run", "build"], { cwd: ROOT, stdio: "pipe" });

    const pkg = JSON.parse(readFileSync(path.join(ROOT, "dist/package.json"), "utf8"));
    expect(pkg).toEqual({ type: "module" });

    for (const f of ["dist/handlers/index.js", "dist/handlers/budget-guard.js"]) {
      expect(existsSync(path.join(ROOT, f))).toBe(true);
    }
    const http = await import(path.join(ROOT, "dist/handlers/index.js"));
    const guard = await import(path.join(ROOT, "dist/handlers/budget-guard.js"));
    expect(typeof http.handler).toBe("function");
    expect(typeof guard.handler).toBe("function");
  }, 120_000);
});
