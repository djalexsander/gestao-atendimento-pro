import { AgentApi, DOCUMENT_LABEL, type LogicalDevice } from "./core/api.ts";
import { PrintAgentApp, type Snapshot, type WindowsPrinter } from "./core/app.ts";
import { parsePublicConfig } from "./core/config.ts";
import { buildDiagnosticDocument } from "./core/document-builders.ts";
import { CODE_PAGE_LABEL, CUT_MODE_LABEL, columnsFor, type CodePage, type CutMode, type PaperWidth } from "./core/document.ts";
import { renderEscPos } from "./core/escpos.ts";
import { defaultDiagnosticPrinter, isVirtualPrinter, looksLikeLabelPrinter } from "./core/printer-kind.ts";
import { renderText } from "./core/text-renderer.ts";
import { RawEscPosPrinterTransport } from "./core/transport.ts";
import { computerName, listWindowsPrinters, nativeRawPort, nativeSecrets, nativeStore } from "./tauri.ts";
import "./style.css";

const root = document.getElementById("app")!;
const config = parsePublicConfig(import.meta.env as unknown as Record<string, unknown>);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(c);
  return node;
}

const hhmm = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// ---- Diagnóstico de impressão (local, SEM Supabase). A impressão física só acontece no clique explícito
// em "Imprimir teste físico"; nada aqui roda sozinho.
const diag = {
  printer: "",
  touched: false,
  width: 80 as PaperWidth,
  codePage: "cp850" as CodePage,
  cutMode: "partial" as CutMode,
  prepared: null as { preview: string[]; bytes: number; key: string } | null,
  status: null as { text: string; kind: "ok" | "error" } | null,
  busy: false,
};
const diagKey = () => `${diag.printer}|${diag.width}|${diag.codePage}|${diag.cutMode}`;

function diagnosticSection(printers: WindowsPrinter[], rerender: () => void): HTMLElement {
  if (!diag.touched) diag.printer = defaultDiagnosticPrinter(printers);
  const invalidate = () => {
    diag.prepared = null;
    diag.status = null;
    rerender();
  };

  const printerSelect = el("select", { id: "diag-printer" });
  printerSelect.append(el("option", { value: "" }, "Selecione a impressora"));
  for (const p of printers) {
    const tags = [p.isDefault ? "padrão" : "", isVirtualPrinter(p.name) ? "impressora virtual" : "", looksLikeLabelPrinter(p.name) ? "etiquetas?" : ""].filter(Boolean);
    printerSelect.append(el("option", { value: p.name }, tags.length ? `${p.name} (${tags.join(", ")})` : p.name));
  }
  printerSelect.value = diag.printer;
  printerSelect.addEventListener("change", () => {
    diag.printer = printerSelect.value;
    diag.touched = true;
    invalidate();
  });

  const widthSelect = el("select", { id: "diag-width" }, el("option", { value: "80" }, "80 mm"), el("option", { value: "58" }, "58 mm"));
  widthSelect.value = String(diag.width);
  widthSelect.addEventListener("change", () => {
    diag.width = Number(widthSelect.value) === 58 ? 58 : 80;
    invalidate();
  });

  const pageSelect = el("select", { id: "diag-page" });
  for (const [value, label] of Object.entries(CODE_PAGE_LABEL)) pageSelect.append(el("option", { value }, label));
  pageSelect.value = diag.codePage;
  pageSelect.addEventListener("change", () => {
    diag.codePage = pageSelect.value as CodePage;
    invalidate();
  });

  const cutSelect = el("select", { id: "diag-cut" });
  for (const [value, label] of Object.entries(CUT_MODE_LABEL)) cutSelect.append(el("option", { value }, label));
  cutSelect.value = diag.cutMode;
  cutSelect.addEventListener("change", () => {
    diag.cutMode = cutSelect.value as CutMode;
    invalidate();
  });

  const virtual = diag.printer !== "" && isVirtualPrinter(diag.printer);
  const label = diag.printer !== "" && looksLikeLabelPrinter(diag.printer);

  const prepare = el("button", { id: "diag-prepare" }, "Preparar teste");
  prepare.addEventListener("click", () => {
    if (!diag.printer) return;
    const document_ = buildDiagnosticDocument({ printerName: diag.printer, paperWidth: diag.width, codePage: diag.codePage });
    const columns = columnsFor(diag.width);
    const bytes = renderEscPos(document_, { columns, codePage: diag.codePage, cutMode: diag.cutMode });
    diag.prepared = { preview: renderText(document_, columns), bytes: bytes.length, key: diagKey() };
    diag.status = null;
    rerender();
  });
  if (!diag.printer) prepare.setAttribute("disabled", "true");

  const physical = el("button", { id: "diag-print", class: "danger" }, "Imprimir teste físico");
  if (!diag.prepared || diag.prepared.key !== diagKey() || virtual || diag.busy) physical.setAttribute("disabled", "true");
  physical.addEventListener("click", async () => {
    if (!diag.prepared || diag.busy || virtual || !diag.printer) return;
    // Confirmação EXPLÍCITA antes de gastar papel (e alerta forte para impressora de etiquetas).
    const warning = looksLikeLabelPrinter(diag.printer) ? "Esta impressora parece ser de etiquetas.\n\n" : "";
    if (!window.confirm(`${warning}Isto vai IMPRIMIR de verdade em "${diag.printer}" (${diag.width} mm, ${CODE_PAGE_LABEL[diag.codePage]}). Continuar?`)) return;
    diag.busy = true;
    diag.status = null;
    rerender();
    try {
      const doc = buildDiagnosticDocument({ printerName: diag.printer, paperWidth: diag.width, codePage: diag.codePage });
      const result = await new RawEscPosPrinterTransport(nativeRawPort, "diagnostic").print({
        printerName: diag.printer,
        paperWidth: diag.width,
        codePage: diag.codePage,
        cutMode: diag.cutMode,
        document: doc,
      });
      diag.status = { text: `Teste enviado ao spooler do Windows (${result.bytes ?? 0} bytes).`, kind: "ok" };
    } catch (error) {
      diag.status = { text: error instanceof Error ? error.message : String(error), kind: "error" };
    }
    diag.busy = false;
    rerender();
  });

  const section = el(
    "section",
    { class: "diag" },
    el("h2", {}, "Diagnóstico de impressão"),
    el("p", { class: "muted" }, "Teste local, sem servidor. O teste físico só imprime quando você clica em “Imprimir teste físico”."),
    el("label", { for: "diag-printer" }, "Impressora Windows"),
    printerSelect,
    el("label", { for: "diag-width" }, "Largura"),
    widthSelect,
    el("label", { for: "diag-page" }, "Code page"),
    pageSelect,
    el("label", { for: "diag-cut" }, "Corte"),
    cutSelect,
  );
  if (label) section.append(el("p", { class: "error", role: "alert" }, "Esta impressora parece ser de etiquetas. Um teste ESC/POS pode imprimir lixo ou desperdiçar etiquetas."));
  if (virtual) section.append(el("p", { class: "error", role: "alert" }, "Provável impressora virtual: não serve para teste ESC/POS."));
  section.append(el("div", { class: "bind" }, prepare, physical));
  if (diag.prepared) {
    section.append(el("p", { class: "muted" }, `Preview (${diag.prepared.bytes} bytes ESC/POS):`), el("pre", { class: "paper" }, diag.prepared.preview.join("\n")));
  }
  if (diag.status) section.append(el("p", { class: diag.status.kind === "ok" ? "ok" : "error", role: "status" }, diag.status.text));
  return section;
}

if (!config) {
  root.replaceChildren(
    el("main", { class: "wrap" }, el("h1", {}, "Agente de Impressão"), el("p", { class: "error" }, "Configuração ausente: defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY (chave pública) no .env da raiz e gere o app de novo.")),
  );
} else {
  const app = new PrintAgentApp({
    api: new AgentApi({ supabaseUrl: config.supabaseUrl, anonKey: config.anonKey }, (url, init) => fetch(url, init)),
    store: nativeStore,
    secrets: nativeSecrets,
    rawPort: nativeRawPort,
    listPrinters: listWindowsPrinters,
    hostName: computerName,
    newId: () => crypto.randomUUID(),
  });

  // Estado de UI que o render não pode perder (campos digitados, seleções).
  const draft = { code: "", name: "", busy: false, picks: new Map<string, string>() };

  function statusText(s: Snapshot): { text: string; cls: string } {
    if (s.phase === "unpaired") return { text: "Não conectado", cls: "off" };
    if (s.phase === "revoked") return { text: "Desconectado pelo sistema", cls: "off" };
    if (s.connection === "offline") return { text: "Sem conexão com o servidor", cls: "warn" };
    if (s.connection === "online") return { text: "Conectado", cls: "ok" };
    return { text: "Conectando…", cls: "warn" };
  }

  function printersSection(printers: WindowsPrinter[]): HTMLElement {
    const list = el("ul", { class: "printers" });
    for (const p of printers) {
      list.append(
        el(
          "li",
          {},
          p.name,
          p.isDefault ? el("span", { class: "tag" }, "padrão") : "",
          isVirtualPrinter(p.name) ? el("span", { class: "tag" }, "impressora virtual") : "",
          looksLikeLabelPrinter(p.name) ? el("span", { class: "tag" }, "etiquetas?") : "",
        ),
      );
    }
    return el("section", {}, el("h2", {}, "Impressoras encontradas no Windows"), printers.length ? list : el("p", { class: "muted" }, "Nenhuma impressora encontrada."));
  }

  function deviceRow(d: LogicalDevice, printers: WindowsPrinter[]): HTMLElement {
    const dest = [d.fullOrder ? "Pedido completo" : "", ...d.sectors, ...d.documents.map((x) => DOCUMENT_LABEL[x] ?? x)].filter(Boolean).join(", ") || "Nenhum destino";
    const row = el("div", { class: "device" }, el("strong", {}, d.name), el("span", { class: "muted" }, ` ${d.paperWidth} mm`), el("div", { class: "muted" }, `Destinos: ${dest}`));
    if (d.boundToOther) {
      row.append(el("div", { class: "muted" }, "Vinculada a outro computador."));
      return row;
    }
    const select = el("select", {});
    select.append(el("option", { value: "" }, "Selecionar impressora Windows"));
    for (const p of printers) select.append(el("option", { value: p.name }, p.name));
    select.value = draft.picks.get(d.id) ?? d.windowsPrinterName ?? "";
    select.addEventListener("change", () => draft.picks.set(d.id, select.value));
    const button = el("button", {}, d.boundToMe ? "Alterar" : "Vincular");
    button.addEventListener("click", async () => {
      const pick = select.value;
      if (!pick) return;
      button.setAttribute("disabled", "true");
      await app.bindDevice(d.id, pick);
      draft.picks.delete(d.id);
    });
    row.append(el("div", { class: "bind" }, select, button));
    row.append(el("div", { class: d.isReady ? "ok" : "muted" }, d.boundToMe && d.windowsPrinterName ? `→ ${d.windowsPrinterName} · ${d.isReady ? "Pronta" : "Aguardando"}` : "Não vinculada"));
    return row;
  }

  // Confirmação explícita SIMULAÇÃO -> REAL (nunca ativa sozinha).
  function askEnableReal(): void {
    const dialog = el("dialog", { class: "confirm" });
    const cancel = el("button", { class: "secondary" }, "Cancelar");
    const enable = el("button", { class: "danger" }, "Ativar impressão real");
    dialog.append(
      el("h2", {}, "Ativar impressão real?"),
      el("p", {}, "A partir de agora, pedidos recebidos pelo Agente serão enviados automaticamente às impressoras vinculadas."),
      el("div", { class: "bind" }, cancel, enable),
    );
    const close = () => {
      dialog.close();
      dialog.remove();
    };
    cancel.addEventListener("click", close);
    dialog.addEventListener("cancel", () => dialog.remove());
    enable.addEventListener("click", async () => {
      close();
      await app.setPrintMode("real");
    });
    document.body.append(dialog);
    dialog.showModal();
  }

  function modeSection(s: Snapshot): HTMLElement {
    const real = s.printMode === "real";
    const sim = el("button", { class: real ? "secondary" : "", "aria-pressed": String(!real) }, "Simulação");
    const live = el("button", { class: real ? "danger" : "secondary", "aria-pressed": String(real) }, "Real");
    sim.addEventListener("click", () => {
      if (real) void app.setPrintMode("simulation");
    });
    live.addEventListener("click", () => {
      if (!real) askEnableReal();
    });
    const section = el(
      "section",
      { class: "mode" },
      el("h2", {}, "Modo de impressão"),
      el("div", { class: "bind" }, sim, live),
      el("p", { class: real ? "mode-banner real" : "mode-banner" }, real ? "Modo REAL — pedidos recebidos serão impressos automaticamente." : "Modo simulação — nenhum pedido será enviado para a impressora."),
    );
    if (!real) section.append(el("p", { class: "muted" }, "Fila automática pausada — modo simulação."));
    return section;
  }

  function render(): void {
    const s = app.snapshot();
    const status = statusText(s);
    const main = el("main", { class: "wrap" });
    main.append(el("header", {}, el("div", { class: "brand" }, "Gestão Atendimento Pro"), el("h1", {}, "Agente de Impressão")));
    main.append(el("p", { class: `status ${status.cls}` }, "Status: ", el("strong", {}, status.text)));
    if (s.message) main.append(el("p", { class: "error", role: "alert" }, s.message));

    if (s.phase === "booting") {
      main.append(el("p", { class: "muted" }, "Iniciando…"));
    } else if (s.phase === "unpaired" || s.phase === "revoked") {
      if (s.phase === "revoked") main.append(el("p", { class: "muted" }, "Gere um novo código em Configurações → Impressão → Agentes."));
      const code = el("input", { id: "code", inputmode: "numeric", autocomplete: "off", placeholder: "0000 0000", maxlength: "9" });
      code.value = draft.code;
      code.addEventListener("input", () => (draft.code = code.value));
      const name = el("input", { id: "name", placeholder: "Caixa Principal", maxlength: "80" });
      name.value = draft.name || s.computerName;
      name.addEventListener("input", () => (draft.name = name.value));
      const submit = el("button", {}, "Conectar este computador");
      submit.addEventListener("click", async () => {
        if (draft.busy) return;
        draft.busy = true;
        submit.setAttribute("disabled", "true");
        if (s.phase === "revoked") app.startOver();
        const ok = await app.pair(draft.code, draft.name || s.computerName);
        draft.busy = false;
        if (ok) draft.code = "";
      });
      main.append(el("section", {}, el("label", { for: "code" }, "Código de conexão"), code, el("label", { for: "name" }, "Nome deste computador"), name, submit));
      main.append(printersSection(s.printers));
    } else {
      main.append(el("dl", { class: "info" }, el("dt", {}, "Computador"), el("dd", {}, s.computerName || "—"), el("dt", {}, "Agente"), el("dd", {}, s.agentName ?? "—"), el("dt", {}, "Empresa"), el("dd", {}, s.companyName ?? "—")));
      main.append(modeSection(s));
      main.append(printersSection(s.printers));
      const devices = el("section", {}, el("h2", {}, "Impressoras do sistema"));
      if (s.devices.length === 0) devices.append(el("p", { class: "muted" }, "Nenhuma impressora cadastrada no sistema (Configurações → Impressão)."));
      for (const d of s.devices) devices.append(deviceRow(d, s.printers));
      main.append(devices);
      if (s.preview) main.append(el("section", {}, el("h2", {}, s.printMode === "real" ? "Último papel impresso" : "Último papel simulado"), el("pre", { class: "paper" }, s.preview.join("\n"))));
      const disconnect = el("button", { class: "secondary" }, "Desconectar este computador");
      disconnect.addEventListener("click", () => {
        if (window.confirm("Desconectar este computador do sistema? A credencial será removida daqui. Para apagar o agente do painel, use Revogar em Configurações → Impressão → Agentes.")) void app.disconnect();
      });
      main.append(disconnect);
    }

    if (s.phase !== "booting") main.append(diagnosticSection(s.printers, render));

    const log = el("pre", { class: "log", "aria-label": "Registro" }, ...s.log.map((l) => `${hhmm.format(l.at)} ${l.text}\n`));
    main.append(el("section", {}, el("h2", {}, "Registro"), log));
    const active = document.activeElement;
    const focusId = active instanceof HTMLElement ? active.id : "";
    root.replaceChildren(main);
    if (focusId) document.getElementById(focusId)?.focus();
    log.scrollTop = log.scrollHeight;
  }

  app.subscribe(render);
  render();
  void app.init();
}
