/**
 * Vectores del nombre y apellido (spec 0017, plan.md `## Backend`, AC-9).
 *
 * COMPARTIDO con el catalogo (F12): `renovarte-catalogo` copia este archivo
 * tal cual a `tests/unit/fixtures/nombre-vectores.ts` y prueba que su
 * `validate-contact` da el mismo veredicto que `validarNombre` del servidor
 * (paridad cliente/servidor). Si un vector cambia aca, se re-sincroniza alla.
 *
 * Sin imports, sin dependencias. Valores ficticios; los no ASCII y los de
 * control van como escapes `\u` para que ningun editor o normalizador los
 * altere. Cada vector:
 *   - `entrada`: lo que llega en `contacto.nombre` (`undefined` = clave ausente).
 *   - `esperado`: `{ ok: true, normalizado }` o `{ ok: false, codigo }`, con el
 *     codigo del servidor (`requerido` | `formato` | `largo`). El cliente
 *     mapea `requerido` -> copy de nombre vacio y `formato`/`largo` -> "Revisa
 *     el nombre...".
 * Nota: `maxlength="80"` del input corta el texto crudo; el vector de 81 se
 * prueba contra la funcion pura, no tipeando.
 */

export type VectorNombre = {
  id: string;
  entrada: unknown;
  esperado: { ok: true; normalizado: string } | { ok: false; codigo: "requerido" | "formato" | "largo" };
};

const ok = (normalizado: string) => ({ ok: true as const, normalizado });
const mal = (codigo: "requerido" | "formato" | "largo") => ({ ok: false as const, codigo });

const A80 = "a".repeat(80);

export const NOMBRE_VECTORES: VectorNombre[] = [
  // Vacio, ausente y solo espacios -> requerido
  { id: "ausente", entrada: undefined, esperado: mal("requerido") },
  { id: "vacio", entrada: "", esperado: mal("requerido") },
  { id: "solo-espacios", entrada: "     ", esperado: mal("requerido") },
  { id: "solo-nbsp", entrada: "  ", esperado: mal("requerido") },

  // Largo (en puntos de codigo, tras recortar)
  { id: "1-caracter", entrada: "A", esperado: mal("formato") },
  { id: "2-caracteres", entrada: "Li", esperado: ok("Li") },
  { id: "80-exactos", entrada: A80, esperado: ok(A80) },
  { id: "81", entrada: A80 + "a", esperado: mal("largo") },
  { id: "80-con-espacios-alrededor", entrada: "  " + A80 + "  ", esperado: ok(A80) },

  // Una palabra y alfabetos
  { id: "una-palabra", entrada: "Madonna", esperado: ok("Madonna") },
  { id: "dos-palabras", entrada: "Ana Pérez", esperado: ok("Ana Pérez") },
  { id: "apostrofo", entrada: "O'Brien", esperado: ok("O'Brien") },
  { id: "guion", entrada: "María-José", esperado: ok("María-José") },
  { id: "enie-tildes", entrada: "Ñandú", esperado: ok("Ñandú") },
  { id: "han", entrada: "李雷", esperado: ok("李雷") },
  { id: "a-con-anillo", entrada: "Åsa", esperado: ok("Åsa") },

  // NFC vs NFD del mismo nombre -> mismo normalizado (NFC)
  { id: "nfc", entrada: "María", esperado: ok("María") },
  { id: "nfd", entrada: "María", esperado: ok("María") },

  // Espacios internos colapsados
  { id: "espacios-internos", entrada: "Ana    Pérez", esperado: ok("Ana Pérez") },
  { id: "nbsp-interno", entrada: "Ana  Pérez", esperado: ok("Ana Pérez") },

  // Sin letra -> formato
  { id: "solo-digitos", entrada: "12345", esperado: mal("formato") },
  { id: "solo-simbolos", entrada: "!?-'.", esperado: mal("formato") },

  // Control, separadores y bidi -> formato
  { id: "lf", entrada: "Ana\nPérez", esperado: mal("formato") },
  { id: "cr", entrada: "Ana\rPérez", esperado: mal("formato") },
  { id: "crlf", entrada: "Ana\r\nPérez", esperado: mal("formato") },
  { id: "tab", entrada: "Ana\tPérez", esperado: mal("formato") },
  { id: "nul-cc", entrada: "Ana\u0000Pérez", esperado: mal("formato") },
  { id: "c1-cc", entrada: "Ana\u0085Pérez", esperado: mal("formato") },
  { id: "u2028", entrada: "Ana Pérez", esperado: mal("formato") },
  { id: "u2029", entrada: "Ana Pérez", esperado: mal("formato") },
  { id: "bidi-202e", entrada: "Ana‮Pérez", esperado: mal("formato") },
  { id: "bidi-2066", entrada: "Ana⁦Pérez", esperado: mal("formato") },
  { id: "bidi-2069", entrada: "Ana⁩Pérez", esperado: mal("formato") },
  { id: "sustituto-suelto", entrada: "Ana\ud800Pérez", esperado: mal("formato") },

  // No string -> formato
  { id: "numero", entrada: 12345, esperado: mal("formato") },
  { id: "null", entrada: null, esperado: mal("formato") },
  { id: "objeto", entrada: { nombre: "Ana" }, esperado: mal("formato") },
  { id: "arreglo", entrada: ["Ana"], esperado: mal("formato") },
  { id: "booleano", entrada: true, esperado: mal("formato") },
];
