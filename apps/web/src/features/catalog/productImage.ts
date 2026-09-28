// Processamento da foto do produto — TUDO no navegador, antes do upload (ver migration
// 20260926040000_product_catalog.sql: o bucket product-images só aceita image/webp até 2 MiB).
// Sem React e sem Supabase, de propósito: pega um File escolhido pelo usuário e devolve um Blob
// WebP pronto para envio, já redimensionado e dentro do limite. Nada aqui salva nada — quem
// chama decide o que fazer com o Blob (productsApi.ts faz o upload).

export class ProductImageError extends Error {}

const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_DIMENSION = 600;
const MAX_BYTES = 2 * 1024 * 1024; // 2 MiB — mesmo limite do bucket (file_size_limit)
const INITIAL_QUALITY = 0.8;
const MIN_QUALITY = 0.4;

export interface ProcessedImage {
  blob: Blob;
  previewUrl: string;
  width: number;
  height: number;
}

export function isAcceptedImageType(file: File): boolean {
  return ACCEPTED_TYPES.includes(file.type);
}

// Corrige orientação, redimensiona (sem ampliar imagem pequena) e converte para WebP dentro do
// limite de 2 MiB. Lança ProductImageError com mensagem amigável em qualquer etapa que falhar.
export async function processProductImage(file: File): Promise<ProcessedImage> {
  if (!isAcceptedImageType(file)) {
    throw new ProductImageError("Formato inválido. Envie uma imagem JPEG, PNG ou WebP.");
  }

  let bitmap: ImageBitmap;
  try {
    // imageOrientation: "from-image" força a correção da orientação EXIF (a leitura da foto de
    // celular vem quase sempre com essa tag); não depender do default do navegador.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new ProductImageError("Não foi possível abrir essa imagem. Tente outro arquivo.");
  }

  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_DIMENSION);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new ProductImageError("Não foi possível processar essa imagem neste navegador.");
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await encodeUnderLimit(canvas);
    return { blob, previewUrl: URL.createObjectURL(blob), width, height };
  } finally {
    bitmap.close();
  }
}

// Nunca amplia: só reduz quando a imagem passa do máximo, preservando a proporção.
function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  if (width <= max && height <= max) return { width, height };
  const scale = Math.min(max / width, max / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// 600x600 em WebP raramente chega perto de 2 MiB; a redução de qualidade é uma rede de segurança.
async function encodeUnderLimit(canvas: HTMLCanvasElement): Promise<Blob> {
  let quality = INITIAL_QUALITY;
  let blob = await canvasToWebp(canvas, quality);
  while (blob.size > MAX_BYTES && quality > MIN_QUALITY) {
    quality -= 0.1;
    blob = await canvasToWebp(canvas, quality);
  }
  if (blob.size > MAX_BYTES) {
    throw new ProductImageError("Não foi possível reduzir a imagem abaixo de 2 MB. Tente uma imagem menor.");
  }
  return blob;
}

function canvasToWebp(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        // Navegador sem suporte a encode WebP costuma devolver PNG silenciosamente (ou null):
        // os dois casos precisam de um erro amigável, não um upload que o banco vai recusar.
        if (!blob || blob.type !== "image/webp") {
          reject(new ProductImageError("Este navegador não consegue gerar imagens WebP. Tente outro navegador."));
          return;
        }
        resolve(blob);
      },
      "image/webp",
      quality,
    );
  });
}
