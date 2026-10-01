import { columnsFor, type CodePage, type CutMode, type PaperWidth, type PrintDocument } from "./document.ts";
import { renderEscPos } from "./escpos.ts";
import type { JobModel } from "./model.ts";
import { renderText } from "./text-renderer.ts";

// Transporte de impressão = o último passo do pipeline (claim -> documento -> TRANSPORTE -> complete).
// Jobs do servidor: modo REAL (escolha explícita do usuário, state.json printMode="real") usa o transporte RAW;
// em SIMULAÇÃO o agente nem faz claim. O lado nativo (Rust) também confere o modo salvo antes de aceitar
// purpose="job". O diagnóstico local ("diagnostic") é independente do modo.

import type { PrintMode } from "./config.ts";
export type { PrintMode };

export interface PrintRequest {
  printerName: string | null; // impressora do Windows (null na simulação sem vínculo)
  paperWidth: PaperWidth;
  codePage: CodePage;
  cutMode: CutMode;
  document: PrintDocument;
  job?: JobModel;
}

export interface PrintResult {
  mode: PrintMode;
  preview: string[];
  bytes?: number;
}

export interface PrinterTransport {
  readonly mode: PrintMode;
  print(request: PrintRequest): Promise<PrintResult>;
}

// Não toca em impressora nenhuma: só monta o preview.
export class SimulationPrinterTransport implements PrinterTransport {
  readonly mode = "simulation" as const;
  async print(request: PrintRequest): Promise<PrintResult> {
    return { mode: "simulation", preview: renderText(request.document, columnsFor(request.paperWidth)) };
  }
}

// Porta para a impressão RAW nativa (Tauri). `purpose` é conferido NO RUST.
export interface RawPrinterPort {
  printRaw(printerName: string, bytes: Uint8Array, purpose: "diagnostic" | "job"): Promise<void>;
}

export class RawPrinterError extends Error {}

// Gera ESC/POS e envia RAW ao spooler. Erros do spooler chegam já traduzidos (mensagem amigável).
export class RawEscPosPrinterTransport implements PrinterTransport {
  readonly mode = "real" as const;
  private readonly port: RawPrinterPort;
  private readonly purpose: "diagnostic" | "job";

  constructor(port: RawPrinterPort, purpose: "diagnostic" | "job") {
    this.port = port;
    this.purpose = purpose;
  }

  async print(request: PrintRequest): Promise<PrintResult> {
    if (!request.printerName) throw new RawPrinterError("Nenhuma impressora do Windows selecionada.");
    const columns = columnsFor(request.paperWidth);
    const bytes = renderEscPos(request.document, { columns, codePage: request.codePage, cutMode: request.cutMode });
    try {
      await this.port.printRaw(request.printerName, bytes, this.purpose);
    } catch (error) {
      throw new RawPrinterError(error instanceof Error ? error.message : String(error));
    }
    return { mode: "real", preview: renderText(request.document, columns), bytes: bytes.length };
  }
}
