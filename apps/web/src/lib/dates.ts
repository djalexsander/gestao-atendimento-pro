// Datas financeiras chegam do banco como DATE ("YYYY-MM-DD"). Formatamos pela
// própria string, sem passar por Date, para nunca deslocar o dia por fuso.

export function fmtDateOnly(value: string | null): string {
  if (!value) return "—";
  const [y, m, d] = value.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

// "2026-09-01" -> "09/2026"
export function fmtCompetence(value: string): string {
  const [y, m] = value.slice(0, 7).split("-");
  return `${m}/${y}`;
}

// <input type="month"> ("2026-09") -> competência ("2026-09-01")
export function monthToCompetence(month: string): string | null {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? `${month}-01` : null;
}

export function currentMonthValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
