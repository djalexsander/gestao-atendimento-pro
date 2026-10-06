"""Gera TODOS os ícones dos produtos a partir da arte oficial (branding/gestao-atendimento-pro-arte-oficial.webp).

Ícone do app (Desktop + PWA): só o símbolo (cloche + tablet), SEM o texto "Gestão Atendimento Pro".
Agente de Impressão: mesma base + selo de impressora (família visual, fácil de distinguir).
Uso: python scripts/branding/build_icons.py   (requer Pillow e numpy; gera arquivos versionados dentro dos apps)
"""
import io
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / "branding" / "gestao-atendimento-pro-arte-oficial.webp"
TEXT_TOP = 930  # a partir daqui começa o texto grande da arte (fica fora do ícone)
MASTER = 1024


def symbol_square() -> Image.Image:
    """Recorta o símbolo (acima do texto) e completa para um quadrado com o próprio fundo (borda replicada)."""
    im = Image.open(ART).convert("RGB")
    a = np.array(im)[:TEXT_TOP]
    mask = a.astype(int).sum(axis=2) > 330  # só o metal/tablet (ignora o brilho do fundo)
    ys, xs = np.where(mask)
    x0, x1 = xs.min(), xs.max()
    y0, y1 = ys.min(), ys.max()
    pad = 22
    x0, x1 = max(0, x0 - pad), min(im.width - 1, x1 + pad)
    y0 = y0 - pad
    y1 = min(TEXT_TOP - 1, y1 + pad)
    w, h = x1 - x0 + 1, y1 - y0 + 1
    side = max(w, h)
    region = np.array(im)[max(y0, 0): y1 + 1, x0: x1 + 1]
    # completa para quadrado replicando as bordas do fundo (topo: fundo escuro; laterais: azul escuro)
    top = max(0, -y0) + (side - h - max(0, -y0)) // 2 if side > h else 0
    left = (side - w) // 2 if side > w else 0
    sq = np.pad(region, ((top, side - region.shape[0] - top), (left, side - region.shape[1] - left), (0, 0)), mode="edge")
    return Image.fromarray(sq).resize((MASTER, MASTER), Image.LANCZOS)


def rounded(img: Image.Image, radius_ratio: float = 0.2) -> Image.Image:
    size = img.size[0]
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size * 4 - 1, size * 4 - 1), radius=int(size * 4 * radius_ratio), fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def printer_badge(base: Image.Image) -> Image.Image:
    """Agente de Impressão: mesma arte + selo de impressora (corpo, papel saindo com linhas) no canto inferior direito."""
    s = base.size[0]
    img = base.convert("RGBA")
    layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    r = int(s * 0.215)  # raio do selo
    cx, cy = int(s * 0.715), int(s * 0.715)
    # disco do selo (roxo da marca) com anel claro
    d.ellipse((cx - r - 14, cy - r - 14, cx + r + 14, cy + r + 14), fill=(255, 255, 255, 235))
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(91, 33, 214, 255))
    # impressora: papel saindo (topo), corpo, bandeja, led
    pw, ph = int(r * 0.78), int(r * 0.62)
    d.rounded_rectangle((cx - pw // 2, cy - int(r * 0.78), cx + pw // 2, cy - int(r * 0.78) + ph), radius=10, fill=(255, 255, 255, 255))
    for i in range(3):
        y = cy - int(r * 0.78) + 22 + i * 26
        d.rounded_rectangle((cx - pw // 2 + 18, y, cx + pw // 2 - 18, y + 9), radius=4, fill=(91, 33, 214, 255))
    bw, bh = int(r * 1.38), int(r * 0.62)
    by = cy - int(r * 0.16)
    d.rounded_rectangle((cx - bw // 2, by, cx + bw // 2, by + bh), radius=22, fill=(222, 226, 255, 255))
    d.rounded_rectangle((cx - bw // 2, by + int(bh * 0.55), cx + bw // 2, by + bh), radius=22, fill=(160, 168, 235, 255))
    d.ellipse((cx + bw // 2 - 46, by + 24, cx + bw // 2 - 24, by + 46), fill=(34, 197, 94, 255))
    out_w, out_h = int(r * 0.9), int(r * 0.34)
    d.rounded_rectangle((cx - out_w // 2, by + bh - 12, cx + out_w // 2, by + bh - 12 + out_h), radius=8, fill=(255, 255, 255, 255))
    shadow = layer.filter(ImageFilter.GaussianBlur(10))
    img.alpha_composite(shadow)
    img.alpha_composite(layer)
    return img


def save_png(img: Image.Image, path: Path, size: int):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.resize((size, size), Image.LANCZOS).save(path, "PNG", optimize=True)


def save_ico(img: Image.Image, path: Path, sizes=(16, 24, 32, 48, 64, 128, 256)):
    frames = [img.resize((s, s), Image.LANCZOS).convert("RGBA") for s in sizes]
    frames[-1].save(path, format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[:-1])


def save_icns(img: Image.Image, path: Path):
    """ICNS mínimo (PNG embutido) para o bundle do Tauri; só macOS usa, mas o Tauri exige o arquivo na lista."""
    types = {16: b"icp4", 32: b"icp5", 64: b"icp6", 128: b"ic07", 256: b"ic08", 512: b"ic09", 1024: b"ic10"}
    chunks = b""
    for size, t in types.items():
        buf = io.BytesIO()
        img.resize((size, size), Image.LANCZOS).save(buf, "PNG")
        data = buf.getvalue()
        chunks += t + struct.pack(">I", len(data) + 8) + data
    path.write_bytes(b"icns" + struct.pack(">I", len(chunks) + 8) + chunks)


def tauri_icon_set(icon_dir: Path, art: Image.Image):
    """Mesmos nomes que o `tauri icon` gera (Square*Logo, StoreLogo, 32x32…, icon.ico/icns/png)."""
    for name, size in [("32x32.png", 32), ("64x64.png", 64), ("128x128.png", 128), ("128x128@2x.png", 256), ("icon.png", 512),
                       ("Square30x30Logo.png", 30), ("Square44x44Logo.png", 44), ("Square71x71Logo.png", 71), ("Square89x89Logo.png", 89),
                       ("Square107x107Logo.png", 107), ("Square142x142Logo.png", 142), ("Square150x150Logo.png", 150),
                       ("Square284x284Logo.png", 284), ("Square310x310Logo.png", 310), ("StoreLogo.png", 50)]:
        save_png(art, icon_dir / name, size)
    save_ico(art, icon_dir / "icon.ico")
    save_icns(art, icon_dir / "icon.icns")


def main():
    base = symbol_square()
    app = rounded(base)  # ícone com cantos arredondados (transparentes)
    agent = rounded(printer_badge(base))

    # Desktop (Tauri)
    tauri_icon_set(ROOT / "apps/desktop/src-tauri/icons", app)
    # Agente de Impressão (Tauri) — inclui o ícone da bandeja (usa o ícone padrão da janela)
    tauri_icon_set(ROOT / "apps/print-agent/src-tauri/icons", agent)
    # PWA / Web
    pub = ROOT / "apps/web/public"
    save_png(app, pub / "pwa-192x192.png", 192)
    save_png(app, pub / "pwa-512x512.png", 512)
    save_png(base.convert("RGBA"), pub / "pwa-maskable-512x512.png", 512)  # maskable: sangra até a borda (safe zone do SO)
    # apple-touch-icon: iOS aplica o próprio arredondamento, então vai sem cantos transparentes
    base.convert("RGB").resize((180, 180), Image.LANCZOS).save(pub / "apple-touch-icon.png", "PNG", optimize=True)
    # favicon: PNG 32/ico + SVG que embute o símbolo
    save_ico(app, pub / "favicon.ico", sizes=(16, 32, 48))
    save_png(app, pub / "favicon-32x32.png", 32)
    save_png(app, pub / "favicon-16x16.png", 16)
    # prévias para conferência visual (fora do git: pasta .claude)
    prev = ROOT / ".claude" / "tmp" / "icon-preview"
    prev.mkdir(parents=True, exist_ok=True)
    base.save(prev / "base.png")
    app.save(prev / "app-1024.png")
    agent.save(prev / "agent-1024.png")
    print("ok")


if __name__ == "__main__":
    main()
