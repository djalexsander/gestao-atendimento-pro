//! Impressão de ETIQUETAS pelo DRIVER do Windows (GDI): genérica, sem amarrar a uma marca nem a uma linguagem
//! (ZPL/EPL/TSPL). O frontend do agente desenha a etiqueta num bitmap monocromático (1 bit por pixel) e o Rust o envia
//! como imagem ao driver da impressora (CreateDC -> StartDoc -> StartPage -> StretchDIBits -> EndPage -> EndDoc): qualquer
//! impressora de etiquetas com driver Windows imprime. O tamanho físico do papel é o configurado no DRIVER; aqui o bitmap
//! é escalado para o tamanho da etiqueta em milímetros (resolução real da impressora), nunca além da área imprimível.
//!
//! Mesmo contrato de segurança do RAW: o comando exposto ao frontend passa por `validate` (lado NATIVO): jobs do servidor
//! (purpose "job") só são aceitos com o modo REAL salvo no state.json; o diagnóstico independe do modo; só se imprime em
//! impressora instalada; tamanhos e quantidades têm limite.

use crate::raw_print::{parse_purpose, Purpose};
use serde::Deserialize;

/// Uma página = uma linha física de etiquetas (todas as colunas lado a lado).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelPage {
    pub width_px: u32,
    pub height_px: u32,
    pub width_mm: f32,
    pub height_mm: f32,
    /// 1 bit por pixel, linhas de 4 em 4 bytes (DWORD), topo primeiro; bit 1 = branco, 0 = preto.
    pub data: Vec<u8>,
}

pub const MAX_PAGES: usize = 120;
pub const MAX_SIDE_PX: u32 = 8000;

pub fn stride(width_px: u32) -> usize {
    (((width_px as usize) + 31) / 32) * 4
}

pub fn validate(printer: &str, pages: &[LabelPage], purpose: &str, installed: &[String], real_mode: bool) -> Result<(), String> {
    let purpose = parse_purpose(purpose)?;
    if purpose == Purpose::Job && !real_mode {
        return Err("O modo de impressão REAL não está ativado neste computador. Os jobs do servidor não são impressos em modo simulação.".into());
    }
    if pages.is_empty() {
        return Err("Nenhuma etiqueta para imprimir.".into());
    }
    if pages.len() > MAX_PAGES {
        return Err("Etiquetas demais num único envio.".into());
    }
    for page in pages {
        if page.width_px == 0 || page.height_px == 0 || page.width_px > MAX_SIDE_PX || page.height_px > MAX_SIDE_PX {
            return Err("Tamanho de etiqueta inválido.".into());
        }
        if !(page.width_mm > 0.0 && page.width_mm <= 800.0 && page.height_mm > 0.0 && page.height_mm <= 400.0) {
            return Err("Tamanho físico de etiqueta inválido.".into());
        }
        if page.data.len() != stride(page.width_px) * page.height_px as usize {
            return Err("Imagem da etiqueta inválida.".into());
        }
    }
    if !installed.iter().any(|name| name == printer) {
        return Err(format!("Impressora não encontrada no Windows: {printer}."));
    }
    Ok(())
}

/// Tamanho de destino em pixels do dispositivo: tamanho físico (mm) na resolução real, reduzido (mantendo a proporção)
/// se passar da área imprimível.
pub fn destination_size(width_mm: f32, height_mm: f32, dpi_x: f32, dpi_y: f32, printable_w: i32, printable_h: i32) -> (i32, i32) {
    let want_w = (width_mm / 25.4 * dpi_x).round().max(1.0);
    let want_h = (height_mm / 25.4 * dpi_y).round().max(1.0);
    let scale = (printable_w as f32 / want_w).min(printable_h as f32 / want_h).min(1.0);
    (((want_w * scale).floor() as i32).max(1), ((want_h * scale).floor() as i32).max(1))
}

#[cfg(windows)]
pub fn send(printer: &str, pages: &[LabelPage]) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::GetLastError;
    use windows::Win32::Graphics::Gdi::{
        CreateDCW, DeleteDC, GetDeviceCaps, StretchDIBits, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, HDC, HORZRES, LOGPIXELSX,
        LOGPIXELSY, RGBQUAD, SRCCOPY, VERTRES,
    };
    use windows::Win32::Storage::Xps::{EndDoc, EndPage, StartDocW, StartPage, DOCINFOW};

    #[repr(C)]
    struct Bmi {
        header: BITMAPINFOHEADER,
        colors: [RGBQUAD; 2],
    }

    struct Dc(HDC);
    impl Drop for Dc {
        fn drop(&mut self) {
            unsafe {
                let _ = DeleteDC(self.0);
            }
        }
    }

    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let driver = wide("WINSPOOL");
    let name = wide(printer);
    let doc_name = wide("Gestão Atendimento Pro - Etiquetas");

    unsafe {
        let hdc = CreateDCW(PCWSTR(driver.as_ptr()), PCWSTR(name.as_ptr()), PCWSTR::null(), None);
        if hdc.is_invalid() {
            return Err(format!("Não foi possível abrir a impressora no Windows. (erro {} do Windows)", GetLastError().0));
        }
        let dc = Dc(hdc);

        let info = DOCINFOW {
            cbSize: std::mem::size_of::<DOCINFOW>() as i32,
            lpszDocName: PCWSTR(doc_name.as_ptr()),
            lpszOutput: PCWSTR::null(),
            lpszDatatype: PCWSTR::null(),
            fwType: 0,
        };
        if StartDocW(dc.0, &info) <= 0 {
            return Err(format!("Não foi possível iniciar o documento na impressora. (erro {} do Windows)", GetLastError().0));
        }

        let result = (|| -> Result<(), String> {
            let printable_w = GetDeviceCaps(Some(dc.0), HORZRES);
            let printable_h = GetDeviceCaps(Some(dc.0), VERTRES);
            let dpi_x = GetDeviceCaps(Some(dc.0), LOGPIXELSX).max(1) as f32;
            let dpi_y = GetDeviceCaps(Some(dc.0), LOGPIXELSY).max(1) as f32;
            for page in pages {
                if StartPage(dc.0) <= 0 {
                    return Err(format!("Não foi possível iniciar a página na impressora. (erro {} do Windows)", GetLastError().0));
                }
                let bmi = Bmi {
                    header: BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: page.width_px as i32,
                        biHeight: -(page.height_px as i32), // negativo = topo primeiro
                        biPlanes: 1,
                        biBitCount: 1,
                        biCompression: 0, // BI_RGB
                        biSizeImage: page.data.len() as u32,
                        biXPelsPerMeter: 0,
                        biYPelsPerMeter: 0,
                        biClrUsed: 2,
                        biClrImportant: 2,
                    },
                    // índice 0 = preto, índice 1 = branco
                    colors: [
                        RGBQUAD { rgbBlue: 0, rgbGreen: 0, rgbRed: 0, rgbReserved: 0 },
                        RGBQUAD { rgbBlue: 255, rgbGreen: 255, rgbRed: 255, rgbReserved: 0 },
                    ],
                };
                let (dw, dh) = destination_size(page.width_mm, page.height_mm, dpi_x, dpi_y, printable_w, printable_h);
                let copied = StretchDIBits(
                    dc.0,
                    0,
                    0,
                    dw,
                    dh,
                    0,
                    0,
                    page.width_px as i32,
                    page.height_px as i32,
                    Some(page.data.as_ptr() as *const std::ffi::c_void),
                    &bmi as *const Bmi as *const BITMAPINFO,
                    DIB_RGB_COLORS,
                    SRCCOPY,
                );
                if copied <= 0 {
                    return Err("O driver da impressora recusou a imagem da etiqueta.".to_string());
                }
                if EndPage(dc.0) <= 0 {
                    return Err(format!("Falha ao finalizar a página na impressora. (erro {} do Windows)", GetLastError().0));
                }
            }
            Ok(())
        })();

        let ended = EndDoc(dc.0);
        result?;
        if ended <= 0 {
            return Err(format!("Falha ao finalizar o documento na impressora. (erro {} do Windows)", GetLastError().0));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn send(_printer: &str, _pages: &[LabelPage]) -> Result<(), String> {
    Err("A impressão de etiquetas só está disponível no Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn installed() -> Vec<String> {
        vec!["Argox OS-214".to_string()]
    }
    fn page(w: u32, h: u32) -> LabelPage {
        LabelPage { width_px: w, height_px: h, width_mm: 50.0, height_mm: 30.0, data: vec![0xFF; stride(w) * h as usize] }
    }

    #[test]
    fn stride_is_dword_aligned() {
        assert_eq!(stride(1), 4);
        assert_eq!(stride(32), 4);
        assert_eq!(stride(33), 8);
        assert_eq!(stride(600), 76);
    }

    #[test]
    fn job_requires_real_mode_and_diagnostic_does_not() {
        let p = vec![page(100, 50)];
        assert!(validate("Argox OS-214", &p, "job", &installed(), false).is_err());
        assert!(validate("Argox OS-214", &p, "job", &installed(), true).is_ok());
        assert!(validate("Argox OS-214", &p, "diagnostic", &installed(), false).is_ok());
        assert!(validate("Argox OS-214", &p, "outro", &installed(), true).is_err());
    }

    #[test]
    fn rejects_unknown_printer_empty_oversized_and_wrong_data() {
        assert!(validate("Outra", &[page(100, 50)], "job", &installed(), true).is_err());
        assert!(validate("Argox OS-214", &[], "job", &installed(), true).is_err());
        assert!(validate("Argox OS-214", &[page(9000, 50)], "job", &installed(), true).is_err());
        let mut bad = page(100, 50);
        bad.data.pop();
        assert!(validate("Argox OS-214", &[bad], "job", &installed(), true).is_err());
        let many: Vec<LabelPage> = (0..=MAX_PAGES).map(|_| page(32, 8)).collect();
        assert!(validate("Argox OS-214", &many, "job", &installed(), true).is_err());
    }

    #[test]
    fn destination_keeps_physical_size_and_never_exceeds_printable_area() {
        // 50x30 mm a 203 dpi = 400x240; cabe numa área de 800x600
        assert_eq!(destination_size(50.0, 30.0, 203.0, 203.0, 800, 600), (400, 240));
        // área imprimível menor: reduz mantendo a proporção
        let (w, h) = destination_size(50.0, 30.0, 203.0, 203.0, 200, 600);
        assert_eq!(w, 200);
        assert!((h as f32 - 120.0).abs() <= 1.0);
        // nunca amplia além do tamanho físico
        let (w, _) = destination_size(10.0, 10.0, 203.0, 203.0, 5000, 5000);
        assert!(w < 100);
    }
}
