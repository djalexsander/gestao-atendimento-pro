//! Token do agente no Windows Credential Manager (crate `keyring`, backend nativo do Windows).
//! Nada de arquivo, log ou fallback em texto puro: se o cofre falhar, o erro sobe e o pareamento para.

use keyring::{Entry, Error};

pub const SERVICE: &str = "br.com.gestaoatendimentopro.printagent";
const USER: &str = "agent-token";

fn entry(service: &str) -> Result<Entry, String> {
    Entry::new(service, USER).map_err(|e| format!("cofre indisponível: {e}"))
}

pub fn set(service: &str, token: &str) -> Result<(), String> {
    entry(service)?.set_password(token).map_err(|e| format!("cofre indisponível: {e}"))
}

pub fn get(service: &str) -> Result<Option<String>, String> {
    match entry(service)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("cofre indisponível: {e}")),
    }
}

/// Apagar o que não existe é sucesso (idempotente).
pub fn delete(service: &str) -> Result<(), String> {
    match entry(service)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("cofre indisponível: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Usa um serviço de TESTE próprio e apaga no fim: valida o Credential Manager de verdade sem tocar
    // na credencial do agente.
    #[cfg(windows)]
    #[test]
    fn credential_manager_roundtrip() {
        let service = "br.com.gestaoatendimentopro.printagent.test";
        delete(service).unwrap();
        assert_eq!(get(service).unwrap(), None);
        set(service, "token-de-teste-123").unwrap();
        assert_eq!(get(service).unwrap().as_deref(), Some("token-de-teste-123"));
        set(service, "outro-token").unwrap();
        assert_eq!(get(service).unwrap().as_deref(), Some("outro-token"));
        delete(service).unwrap();
        assert_eq!(get(service).unwrap(), None);
        delete(service).unwrap(); // idempotente
    }
}
