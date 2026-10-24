/**
 * check:leak (B17) — CLI sobre `src/leak-audit.ts`. Corre con `tsx`.
 * Recorre los archivos versionables (git ls-files, o el arbol si no hay git),
 * aplica las reglas y falla si hay hallazgos. Nunca imprime el valor hallado.
 * Se excluyen de los patrones este CLI y `src/leak-audit.ts`, que los definen.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { auditarContenido, auditarEjemplos, auditarNombres, type Hallazgo } from "../src/leak-audit.js";

const ROOT = process.cwd();
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".terraform"]);
const SKIP_FILES = new Set(["pnpm-lock.yaml", "scripts/check-leak.ts", "src/leak-audit.ts"]);
// Se escanea todo lo versionable salvo binarios conocidos (p. ej. `.env.example`, `.html`, `.toml`).
const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".woff", ".woff2", ".ttf"]);

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(full);
    } else if (e.isFile()) yield full;
  }
}

function archivos(): string[] {
  try {
    // Versionados + nuevos sin ignorar (para detectar antes del `git add`).
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: ROOT,
      encoding: "utf-8",
    });
    return out.split("\0").filter((f) => f !== "");
  } catch {
    return [...walk(ROOT)].map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
  }
}

const rutas = archivos().filter((r) => !r.split("/").some((p) => SKIP_DIRS.has(p)));
const hallazgos: Hallazgo[] = [...auditarNombres(rutas), ...auditarEjemplos()];
for (const rel of rutas) {
  if (SKIP_FILES.has(rel) || BINARY_EXT.has(path.extname(rel).toLowerCase())) continue;
  let contenido: string;
  try {
    contenido = readFileSync(path.join(ROOT, rel), "utf-8");
  } catch {
    continue; // borrado en el working tree
  }
  hallazgos.push(...auditarContenido(rel, contenido));
}

if (hallazgos.length > 0) {
  console.error("check:leak FALLÓ — hallazgos (no se imprime el valor):");
  for (const h of hallazgos) console.error(`  ${h.donde}: ${h.regla}`);
  process.exit(1);
}
console.log("check:leak OK");
