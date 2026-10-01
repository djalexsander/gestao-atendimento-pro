// Heurísticas (por NOME) só para avisar o usuário. Não são garantia: quem decide é o usuário.

const VIRTUAL = /pdf|xps|onenote|fax|virtual|document writer|print to file/i;
const LABEL = /label|etiqueta|zebra|\bzpl\b|\btsc\b|argox|elgin l\d/i;

export function isVirtualPrinter(name: string): boolean {
  return VIRTUAL.test(name);
}

export function looksLikeLabelPrinter(name: string): boolean {
  return LABEL.test(name);
}

export interface NamedPrinter {
  name: string;
  isDefault: boolean;
}

// Seleção padrão do diagnóstico: a impressora padrão do Windows, desde que não seja virtual nem de
// etiquetas; senão a primeira que não seja nenhuma das duas; senão nenhuma (usuário escolhe).
export function defaultDiagnosticPrinter(printers: NamedPrinter[]): string {
  const ok = (p: NamedPrinter) => !isVirtualPrinter(p.name) && !looksLikeLabelPrinter(p.name);
  return printers.find((p) => p.isDefault && ok(p))?.name ?? printers.find(ok)?.name ?? "";
}
