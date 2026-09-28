// EAN-13 compartilhado entre TODOS os cadastros com código de barras (Produtos, Comandas/Mesas
// e futuros). Espelha o formato e o dígito verificador do banco (ean13_check_digit,
// ean13_internal_format_valid — migrations 20260926060000 e 20260928010000): só dá feedback
// imediato no cliente; a autoridade final é sempre a CHECK do banco. Regra de arquitetura:
// qualquer cadastro novo com barcode deve reusar isto, não duplicar o cálculo/validação.

// Formato do código interno gerado: "200" + 9 dígitos de sequência + 1 dígito verificador.
export const EAN13_INTERNAL_RE = /^200\d{10}$/;

// Peso 1 nas posições ímpares (1ª..11ª), peso 3 nas pares (2ª..12ª), contando da esquerda.
export function ean13CheckDigit(digits12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    sum += Number(digits12[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

// Opcional: vazio é válido. Barcodes fora do formato interno (legados/próprios do
// estabelecimento) continuam liberados; só o formato 200+13 dígitos tem o dígito verificador
// exigido. `maxLength` fica por conta de quem chama (cada cadastro pode ter seu próprio limite,
// embora hoje todos usem 64).
export function validateEan13AwareBarcode(barcode: string, maxLength: number): string | null {
  if (!barcode) return null;
  if (barcode.length > maxLength) return `Use no máximo ${maxLength} caracteres.`;
  if (/\s/.test(barcode)) return "O código de barras não pode ter espaços.";
  if (EAN13_INTERNAL_RE.test(barcode) && Number(barcode[12]) !== ean13CheckDigit(barcode.slice(0, 12))) {
    return "Código EAN-13 inválido: o dígito verificador não confere.";
  }
  return null;
}
