// Comparação de versão semântica simples (MAJOR.MINOR.PATCH, com "v" opcional e sufixos -pre/+build ignorados).
// Nunca compara como string ("1.0.10" > "1.0.9"). Versão inválida devolve null: quem chama NÃO deve tratar como "nova".

export type SemVer = readonly [number, number, number];

export function parseSemver(raw: unknown): SemVer | null {
  if (typeof raw !== "string") return null;
  const m = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:[-+][0-9A-Za-z.\-+]*)?$/.exec(raw.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1 | 0 | 1; null se alguma das versões for inválida. */
export function compareSemver(a: unknown, b: unknown): -1 | 0 | 1 | null {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

/** A versão publicada é ESTRITAMENTE maior que a em execução? Inválida/igual/menor => false (sem falso positivo). */
export function isNewerVersion(published: unknown, running: unknown): boolean {
  return compareSemver(published, running) === 1;
}
