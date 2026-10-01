//! Enumeração das impressoras instaladas no Windows (somente LISTAR; nada é impresso aqui).

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
    pub name: String,
    pub is_default: bool,
}

/// Ordena (padrão primeiro, depois alfabético sem diferenciar maiúsculas) e remove nomes repetidos.
pub fn normalize(mut printers: Vec<PrinterInfo>) -> Vec<PrinterInfo> {
    printers.sort_by(|a, b| {
        b.is_default
            .cmp(&a.is_default)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    printers.dedup_by(|a, b| a.name == b.name);
    printers
}

#[cfg(windows)]
pub fn list() -> Result<Vec<PrinterInfo>, String> {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Graphics::Printing::{
        EnumPrintersW, GetDefaultPrinterW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_INFO_4W,
    };

    unsafe {
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let mut needed: u32 = 0;
        let mut returned: u32 = 0;
        // 1ª chamada: descobre o tamanho do buffer (falha esperada com buffer vazio).
        let _ = EnumPrintersW(flags, PCWSTR::null(), 4, None, &mut needed, &mut returned);
        if needed == 0 {
            return Ok(Vec::new());
        }
        let mut buffer = vec![0u8; needed as usize];
        EnumPrintersW(flags, PCWSTR::null(), 4, Some(&mut buffer), &mut needed, &mut returned)
            .map_err(|e| format!("EnumPrinters falhou: {e}"))?;

        let default_name = {
            let mut len: u32 = 0;
            let _ = GetDefaultPrinterW(None, &mut len);
            if len == 0 {
                String::new()
            } else {
                let mut name = vec![0u16; len as usize];
                if GetDefaultPrinterW(Some(PWSTR(name.as_mut_ptr())), &mut len).as_bool() {
                    String::from_utf16_lossy(&name[..(len as usize).saturating_sub(1)])
                } else {
                    String::new()
                }
            }
        };

        let infos = std::slice::from_raw_parts(buffer.as_ptr() as *const PRINTER_INFO_4W, returned as usize);
        let printers = infos
            .iter()
            .filter(|info| !info.pPrinterName.is_null())
            .map(|info| {
                let name = info.pPrinterName.to_string().unwrap_or_default();
                let is_default = !default_name.is_empty() && name == default_name;
                PrinterInfo { name, is_default }
            })
            .filter(|p| !p.name.is_empty())
            .collect();
        Ok(normalize(printers))
    }
}

#[cfg(not(windows))]
pub fn list() -> Result<Vec<PrinterInfo>, String> {
    Err("A enumeração de impressoras só está disponível no Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_puts_default_first_sorts_and_dedups() {
        let out = normalize(vec![
            PrinterInfo { name: "pos-80".into(), is_default: false },
            PrinterInfo { name: "Microsoft Print to PDF".into(), is_default: false },
            PrinterInfo { name: "EPSON".into(), is_default: true },
            PrinterInfo { name: "EPSON".into(), is_default: true },
        ]);
        let names: Vec<_> = out.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["EPSON", "Microsoft Print to PDF", "pos-80"]);
    }

    // Só LISTA as impressoras reais deste computador (sem imprimir e sem alterar nada no Windows).
    // Rodar com: cargo test list_real_printers -- --nocapture
    #[cfg(windows)]
    #[test]
    fn list_real_printers() {
        let printers = list().expect("deve enumerar");
        for p in &printers {
            println!("IMPRESSORA: {:?} padrão={}", p.name, p.is_default);
        }
        assert!(printers.iter().filter(|p| p.is_default).count() <= 1);
    }
}
