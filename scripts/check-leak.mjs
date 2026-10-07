#!/usr/bin/env node
/**
 * check:leak — este repo es PÚBLICO (ADR-0006). Falla si algún archivo de
 * texto versionable contiene la forma literal de un secreto o de un
 * identificador que no debe commitearse:
 *   - URL de webhook de Discord (el token es el secreto; ADR-0019),
 *   - ARN con ID de cuenta, o cualquier número de 12 dígitos aislado,
 *   - ID de Discord (snowflake de 17-20 dígitos),
 *   - claves de acceso de AWS.
 * Este archivo define los patrones, así que se auto-excluye.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".terraform"]);
const SKIP_FILES = new Set(["pnpm-lock.yaml", path.join("scripts", "check-leak.mjs")]);
const TEXT_EXT = new Set([
  ".ts", ".mjs", ".cjs", ".js", ".json", ".md", ".yml", ".yaml", ".tf", ".tfvars", ".sh", ".txt", "",
]);

export const FORBIDDEN = [
  { name: "webhook de Discord", re: /discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\S/i },
  { name: "ARN con ID de cuenta", re: /arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d{12}:/i },
  { name: "número de 12 dígitos (¿ID de cuenta AWS?)", re: /(?<![\d.])\d{12}(?![\d.])/ },
  { name: "ID de Discord (17-20 dígitos)", re: /(?<![\d.])\d{17,20}(?![\d.])/ },
  { name: "access key id de AWS", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "secret access key de AWS", re: /aws_secret_access_key\s*[=:]\s*\S{20,}/i },
];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

const hits = [];
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file);
  if (SKIP_FILES.has(rel) || !TEXT_EXT.has(path.extname(file))) continue;
  const lines = readFileSync(file, "utf-8").split("\n");
  lines.forEach((line, i) => {
    for (const { name, re } of FORBIDDEN) {
      if (re.test(line)) hits.push(`${rel}:${i + 1}: ${name}`);
    }
  });
}

if (hits.length > 0) {
  console.error("check:leak FALLÓ — hallazgos (no se imprime el valor):");
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log("check:leak OK");
