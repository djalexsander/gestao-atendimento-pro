# Releases desktop e atualização automática

Dois produtos Windows x64 independentes, no mesmo repositório GitHub. Versão inicial oficial de ambos: **1.0.1**.

| | Gestão Atendimento Pro Desktop | Agente de Impressão |
|---|---|---|
| Projeto | `apps/desktop` (Tauri 2; empacota o build de `apps/web` com `--mode desktop`, sem PWA/service worker) | `apps/print-agent` |
| Identificador | `br.com.gestaoatendimentopro.app` | `br.com.gestaoatendimentopro.printagent` |
| Publisher | Alex Pro Apps | Alex Pro Apps |
| Tag de release | `v1.0.1`, `v1.0.2`… | `print-agent-v1.0.1`, `print-agent-v1.0.2`… |
| Workflow | `.github/workflows/release-desktop.yml` | `.github/workflows/release-print-agent.yml` |
| Manifesto de atualização | release-canal `desktop-latest` → `latest.json` | release-canal `print-agent-latest` → `latest.json` |
| Endpoint no app | `https://github.com/<repo>/releases/download/desktop-latest/latest.json` | `https://github.com/<repo>/releases/download/print-agent-latest/latest.json` |

Cada produto consulta SOMENTE o próprio manifesto (URLs e releases-canal distintos); as tags não se cruzam
(`v[0-9]+.[0-9]+.[0-9]+` não casa com `print-agent-v…`). O `latest.json` aponta para os assets da release versionada.

## Assets por release

- `<Produto>_<versão>_x64-setup.exe` (instalador NSIS, `currentUser`, sem administrador; também é o artefato do updater);
- `<Produto>_<versão>_x64-setup.exe.sig` (assinatura do updater);
- `latest.json` (manifesto da versão; o do canal `*-latest` é sobrescrito a cada release).

## Chave de assinatura do updater (gerada; definitiva)

- Chave ÚNICA para os dois produtos (gerada em 2026-10-05, guardada em `%USERPROFILE%\.gap-updater-keys\`, fora do repositório; fingerprint SHA-256 da pública: `0c6edd954d080e6f6575ac8358a7fabcac875fc2bc11c308ba0e89256c9ef7e`).
- Como foi gerada: `npx tauri signer generate -w <caminho-FORA-do-repositório>/updater.key` (pede senha).
- A chave privada e a senha **nunca** entram no repositório. Guardar em: GitHub Actions Secrets
  `TAURI_SIGNING_PRIVATE_KEY` (conteúdo do arquivo) e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, e uma cópia offline do proprietário.
- A chave PÚBLICA (`updater.key.pub`) vai em `plugins.updater.pubkey` de `apps/desktop/src-tauri/tauri.conf.json` e de
  `apps/print-agent/src-tauri/tauri.conf.json` (chave definitiva já configurada; o texto `REPLACE_WITH_UPDATER_PUBLIC_KEY` era o placeholder). Com o placeholder, os apps
  NÃO consultam atualização e os workflows de release recusam rodar.
- Os dois produtos podem usar a mesma chave (a assinatura prova a origem; o manifesto separa os canais) ou uma por produto.
- Perder a chave privada impede atualizar os apps já instalados: manter a cópia offline.

## Build de release (CI)

`createUpdaterArtifacts` só é ligado no build de release (`tauri.release.conf.json`, via `--config`), para o build local
sem chave continuar funcionando. Variables públicas do repositório (Settings → Variables): `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`, `VITE_VAPID_PUBLIC_KEY`. Nenhum segredo de servidor (service_role, Asaas, tokens) entra nos apps.

## Experiência de atualização

- **Desktop:** ao abrir, consulta o manifesto; se houver versão nova mostra "Nova versão disponível" (versão atual/nova) com
  **Atualizar agora** / **Depois**. Ao aceitar: baixa, valida a assinatura, instala e reinicia. Sem atualização silenciosa.
- **Agente:** consulta ao iniciar e a cada 6 h; avisa com toast discreto e mostra a seção "Atualização" na janela.
  **Nunca instala com impressão em andamento** (claim/jobs sendo processados): o clique é recusado até ficar ocioso.
  Durante a instalação pausa heartbeat e fila; se falhar, retoma. Pareamento (Credential Manager), `state.json`,
  autostart e configurações ficam em app data/cofre, fora do instalador, e são preservados no upgrade.

## Teste obrigatório antes de dar o updater como validado (nos DOIS produtos)

1. instalar 1.0.1; 2. publicar 1.0.2 de teste; 3. abrir a 1.0.1; 4. detectar a 1.0.2; 5. baixar; 6. validar assinatura;
7. instalar; 8. reiniciar; 9. confirmar versão 1.0.2; 10. confirmar dados/configurações preservados.
