/**
 * Auditoria de fugas (B17; AC-16, AC-17, AC-26). Los canarios se arman con
 * piezas para que ESTE archivo no dispare `pnpm check:leak`.
 */
import { describe, expect, it } from "vitest";
import {
  EMAIL_PLACEHOLDER,
  auditarContenido,
  auditarEjemplos,
  auditarNombres,
  auditarSalida,
  ejemplosDeSalida,
  sinComentarios,
} from "../src/leak-audit.js";

const reglas = (h: Array<{ regla: string }>): string[] => h.map((x) => x.regla);

// Canarios partidos en piezas.
const WEBHOOK = ["https://disc", "ord.com/api/web", "hooks/", "1".repeat(18), "/tok"].join("");
const WEBHOOK_APP = ["https://disc", "ordapp.com/api/v10/web", "hooks/", "1".repeat(18), "/tok"].join("");
const CUENTA = "9".repeat(12);
const ARN = ["arn:aws:", "iam::", CUENTA, ":role/x"].join("");
const AKIA = ["AK", "IA", "A".repeat(16)].join("");
const PEM = ["-----BEGIN ", "RSA PRIVATE", " KEY-----"].join("");
const GH = ["gh", "p_", "a".repeat(36)].join("");
const SNOWFLAKE = "8".repeat(18);

describe("leak-audit: patrones globales (cualquier archivo)", () => {
  it.each([
    ["webhook de Discord", WEBHOOK],
    ["webhook de Discord", WEBHOOK_APP],
    ["ARN con ID de cuenta", ARN],
    ["numero de 12 digitos", `cuenta ${CUENTA}`],
    ["ID de Discord", `canal ${SNOWFLAKE}`],
    ["access key id de AWS", `k = ${AKIA}`],
    ["clave privada (PEM)", PEM],
    ["token de GitHub", GH],
  ])("detecta %s", (regla, texto) => {
    const h = auditarContenido("docs/x.md", `linea limpia\n${texto}\n`);
    expect(reglas(h).some((r) => r.includes(regla))).toBe(true);
    expect(h[0]!.donde).toBe("docs/x.md:2");
  });

  it("el hallazgo no contiene el valor", () => {
    const s = JSON.stringify(auditarContenido("docs/x.md", WEBHOOK + " " + AKIA));
    expect(s).not.toContain("1".repeat(18));
    expect(s).not.toContain(AKIA);
  });

  it("texto normal no dispara", () => {
    expect(auditarContenido("docs/x.md", "Una orden RA-48271 por $ 20.000, version 1.2.3.4")).toEqual([]);
  });
});

describe("leak-audit: nombres de archivo", () => {
  it.each(["terraform/prod.tfvars", "a/b/terraform.tfstate", "terraform.tfstate.backup", ".env", "x/.env.local", "k/id.pem"])(
    "prohibe %s",
    (r) => expect(auditarNombres([r])).toHaveLength(1),
  );
  it.each([".env.example", "terraform/terraform.tfvars.example", "src/env.ts", "README.md"])("permite %s", (r) =>
    expect(auditarNombres([r])).toEqual([]),
  );
});

describe("leak-audit: reglas de src/", () => {
  it("tokens de costo, margen y LACA en codigo de src/", () => {
    for (const t of ["precio_costo", "margen", "precioLista", "LACA", "markup"]) {
      const h = auditarContenido("src/x.ts", `const a = { ${t}: 1 };`);
      expect(reglas(h), t).toContain("token de costo/margen/LACA en src/");
    }
  });

  it("no aplica fuera de src/ ni en comentarios", () => {
    expect(auditarContenido("tests/x.ts", "const margen = 1;")).toEqual([]);
    expect(auditarContenido("src/x.ts", "// costo, margen y precio LACA\n/* margen\n LACA */\nconst a = 1;")).toEqual([]);
  });

  it("'costo' solo (ledger) no es un token de src/", () => {
    expect(auditarContenido("src/ledger.ts", "const costoMailUsd = 1;")).toEqual([]);
  });

  it("email literal en src/ salvo el placeholder", () => {
    expect(reglas(auditarContenido("src/x.ts", 'const d = "persona@ejemplo.org";'))).toContain("email literal en src/");
    expect(auditarContenido("src/x.ts", `const d = "${EMAIL_PLACEHOLDER}";`)).toEqual([]);
    expect(auditarContenido("src/x.ts", 'import x from "@aws-sdk/client-ses";')).toEqual([]);
    expect(auditarContenido("tests/x.ts", 'const d = "persona@ejemplo.org";')).toEqual([]);
  });

  it("sinComentarios conserva numeracion de lineas", () => {
    expect(sinComentarios("a\n/* x\ny */\nb // c").split("\n")).toHaveLength(4);
  });
});

describe("leak-audit: salidas renderizadas", () => {
  it("el mail, el Discord (con adjunto) y los JSON de ejemplo estan limpios", () => {
    const ej = ejemplosDeSalida();
    expect(ej.map((e) => e.nombre)).toEqual(
      expect.arrayContaining(["ejemplo:mail", "ejemplo:discord", "ejemplo:json-1", "ejemplo:json-7"]),
    );
    expect(auditarEjemplos()).toEqual([]);
  });

  it("las claves sensibles del catalogo de entrada no llegan a ninguna salida", () => {
    const todo = ejemplosDeSalida().map((e) => e.texto).join("\n").toLowerCase();
    for (const v of ["111", "0.3", "222", "precio_costo", "margen", "laca"]) expect(todo).not.toContain(v);
  });

  it("detecta un token filtrado en una salida", () => {
    expect(auditarSalida("ejemplo:mail", "Total ... precio_costo: 5")).toHaveLength(1);
    expect(auditarSalida("ejemplo:discord", "margen del 30%")).toHaveLength(1);
    expect(auditarSalida("ejemplo:discord", WEBHOOK)).not.toHaveLength(0);
  });
});
