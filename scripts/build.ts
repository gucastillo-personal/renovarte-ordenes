/**
 * build — compila src/ a dist/ con tsc (sin bundler) para el zip de Lambda.
 * 1) limpia dist/; 2) tsc -p tsconfig.build.json; 3) escribe dist/package.json
 * con {"type":"module"}: tsc no lo copia y sin el, Lambda trata los .js como
 * CommonJS y falla en runtime. Terraform (archive_file) empaqueta dist/.
 */
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIST = path.join(ROOT, "dist");

rmSync(DIST, { recursive: true, force: true });
execFileSync("pnpm", ["exec", "tsc", "-p", "tsconfig.build.json"], { cwd: ROOT, stdio: "inherit" });
writeFileSync(path.join(DIST, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
console.log("build ok: dist/ listo (handlers/index.handler, handlers/budget-guard.handler)");
