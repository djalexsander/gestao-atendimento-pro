import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../app/useAuth";
import { supabaseLabelsSource, type LabelsSource } from "./labelsApi";
import { LabelPreview } from "./LabelPreview";
import {
  DEFAULT_POINT_FIELDS,
  DEFAULT_PRODUCT_FIELDS,
  EMPTY_FREE,
  defaultPrinterId,
  freeContent,
  freeProblem,
  geometryOf,
  modesForRole,
  MODE_LABEL,
  pointContent,
  priceText,
  productContent,
  productProblem,
  QTY_MAX,
  validateQuantity,
  type BarcodeType,
  type FreeDraft,
  type LabelMode,
  type LabelPrinterOption,
  type PointFields,
  type ProductFields,
  type ProductOption,
  type ServicePointOption,
} from "./labelsLogic";

const MODE_HINT: Record<LabelMode, string> = {
  product: "Etiqueta de um produto cadastrado, com nome, preço e código de barras.",
  free: "Monte uma etiqueta sem vínculo com produto: textos, valor e código opcional.",
  service_point: "Cartão de comanda ou mesa com o código de barras já cadastrado.",
};

function Check({ id, label, checked, onChange, disabled }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="checkbox-row lab-check" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

// Operacional/Administrativo → Etiquetas: etiquetas de produto, impressão livre e cartões de comanda/mesa pela MESMA
// fila de impressão (o Agente de Impressão imprime). A configuração de impressoras fica em Configurações → Impressão.
export function LabelsPage({ source = supabaseLabelsSource }: { source?: LabelsSource }) {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const role = activeMembership?.role ?? null;
  const companyName = activeMembership?.company.name ?? "";
  const modes = modesForRole(role);
  const isManager = role === "owner" || role === "admin";

  const [mode, setMode] = useState<LabelMode>(modes[0] ?? "service_point");
  const [printers, setPrinters] = useState<LabelPrinterOption[] | null>(null);
  const [printerId, setPrinterId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);

  // produto
  const [productTerm, setProductTerm] = useState("");
  const [productResults, setProductResults] = useState<ProductOption[]>([]);
  const [product, setProduct] = useState<ProductOption | null>(null);
  const [productFields, setProductFields] = useState<ProductFields>(DEFAULT_PRODUCT_FIELDS);
  const [searching, setSearching] = useState(false);
  const [generating, setGenerating] = useState(false);
  // livre
  const [free, setFree] = useState<FreeDraft>(EMPTY_FREE);
  // comanda/mesa
  const [pointTerm, setPointTerm] = useState("");
  const [points, setPoints] = useState<ServicePointOption[]>([]);
  const [point, setPoint] = useState<ServicePointOption | null>(null);
  const [pointFields, setPointFields] = useState<PointFields>(DEFAULT_POINT_FIELDS);
  const seq = useRef(0);

  const loadPrinters = useCallback(async () => {
    if (!companyId) return;
    setLoadError(null);
    const result = await source.listPrinters(companyId);
    if (result.error || !result.data) {
      setLoadError(result.error);
      return;
    }
    setPrinters(result.data);
    setPrinterId((current) => (current && result.data.some((p) => p.id === current) ? current : defaultPrinterId(result.data)));
  }, [companyId, source]);

  useEffect(() => {
    void loadPrinters();
  }, [loadPrinters]);

  // Busca de produto (350 ms, a partir de 2 caracteres).
  useEffect(() => {
    if (!companyId || mode !== "product") return;
    const term = productTerm.trim();
    if (term.length < 2) {
      seq.current++;
      return;
    }
    const id = ++seq.current;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      const result = await source.searchProducts(companyId, term);
      if (id !== seq.current) return;
      setSearching(false);
      if (result.error || !result.data) setError(result.error);
      else setProductResults(result.data);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [productTerm, mode, companyId, source]);

  // Comandas/mesas: lista curta ao abrir a aba e filtro com espera.
  useEffect(() => {
    if (!companyId || mode !== "service_point") return;
    const id = ++seq.current;
    const timer = window.setTimeout(async () => {
      const result = await source.searchServicePoints(companyId, pointTerm);
      if (id !== seq.current) return;
      if (result.error || !result.data) setError(result.error);
      else setPoints(result.data);
    }, pointTerm.trim() === "" ? 0 : 350);
    return () => window.clearTimeout(timer);
  }, [pointTerm, mode, companyId, source]);

  const printer = printers?.find((p) => p.id === printerId) ?? null;
  const max = QTY_MAX[mode];
  const qty = validateQuantity(quantity, max);
  const qtyNumber = "quantity" in qty ? qty.quantity : 1;

  const content = useMemo(() => {
    if (mode === "product") return product ? productContent(product, productFields, companyName) : null;
    if (mode === "free") return freeProblem(free) ? null : freeContent(free, companyName);
    return point ? pointContent(point, pointFields, companyName) : null;
  }, [mode, product, productFields, free, point, pointFields, companyName]);

  function switchMode(next: LabelMode) {
    setMode(next);
    setError(null);
    setNotice(null);
    setQuantity("1");
  }

  const problem = (() => {
    if ("error" in qty) return qty.error;
    if (mode === "product") return productProblem(product, productFields);
    if (mode === "free") return freeProblem(free);
    return point ? null : "Escolha uma comanda ou mesa.";
  })();

  async function generateBarcode() {
    if (!product || generating) return;
    setGenerating(true);
    setError(null);
    const result = await source.generateProductBarcode(product.id);
    setGenerating(false);
    if (result.error || !result.data) {
      setError(result.error);
      return;
    }
    const next = { ...product, barcode: result.data };
    setProduct(next);
    setProductResults((list) => list.map((p) => (p.id === next.id ? next : p)));
    setNotice("Código de barras EAN-13 gerado e salvo no cadastro do produto.");
  }

  async function print() {
    if (!companyId || printing) return;
    setError(null);
    setNotice(null);
    if (problem) {
      setError(problem);
      return;
    }
    if (!printer) {
      setError("Escolha a impressora de etiquetas.");
      return;
    }
    setPrinting(true);
    let result: { error: string | null };
    if (mode === "product") result = await source.printProduct(companyId, product!.id, printer.id, qtyNumber, productFields);
    else if (mode === "free") result = await source.printFree(companyId, printer.id, qtyNumber, free);
    else result = await source.printServicePoint(companyId, point!.id, printer.id, qtyNumber, pointFields);
    setPrinting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setNotice(`${qtyNumber} ${qtyNumber === 1 ? "etiqueta enviada" : "etiquetas enviadas"} para a fila de impressão (${printer.name}).`);
  }

  if (modes.length === 0) return <p className="form-notice">Seu perfil não tem acesso à impressão de etiquetas.</p>;

  const setFreeField = (key: keyof FreeDraft) => (e: { target: { value: string } }) => setFree({ ...free, [key]: e.target.value });
  const noPrinter = printers !== null && printers.length === 0;

  return (
    <div className="lab-page">
      <div className="lab-modes" role="tablist" aria-label="O que imprimir">
        {modes.map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? "lab-mode lab-mode-active" : "lab-mode"} onClick={() => switchMode(m)}>
            <strong>{MODE_LABEL[m]}</strong>
            <small>{MODE_HINT[m]}</small>
          </button>
        ))}
      </div>

      {loadError && (
        <div className="form-error fin-error" role="alert">
          <p>{loadError}</p>
          <button className="btn-secondary btn-auto" type="button" onClick={() => void loadPrinters()}>
            Tentar novamente
          </button>
        </div>
      )}
      {noPrinter && (
        <div className="form-notice" role="status">
          Nenhuma impressora de etiquetas configurada.{" "}
          {isManager ? <Link to="/app/configuracoes/impressao">Adicionar impressora de etiquetas</Link> : "Peça ao administrador para cadastrar."}
        </div>
      )}

      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="form-notice" role="status">
          {notice}
        </div>
      )}

      <div className="lab-grid-page">
        <section className="sys-card lab-form">
          {mode === "product" && (
            <>
              <div className="field">
                <label htmlFor="lab-product-search">Buscar produto</label>
                <input id="lab-product-search" type="search" autoComplete="off" placeholder="Nome, código ou código de barras" value={productTerm} onChange={(e) => setProductTerm(e.target.value)} />
                {searching && <span className="field-hint">Buscando…</span>}
              </div>
              {productTerm.trim().length >= 2 && productResults.length > 0 && !product && (
                <ul className="cus-options" aria-label="Produtos encontrados">
                  {productResults.map((p) => (
                    <li key={p.id}>
                      <button type="button" className="cus-option" onClick={() => { setProduct(p); setProductTerm(""); }}>
                        <span>{p.name}</span>
                        <small className="muted">{priceText(p.priceCents)}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {product && (
                <div className="cus-selected">
                  <span>
                    <strong>{product.name}</strong>
                    <small className="muted">
                      {" "}
                      · {priceText(product.priceCents)} · {product.barcode ? `código ${product.barcode}` : "sem código de barras"}
                    </small>
                  </span>
                  <button type="button" className="btn-secondary btn-auto" onClick={() => setProduct(null)}>
                    Trocar
                  </button>
                </div>
              )}
              <fieldset className="print-destinations">
                <legend>O que aparece na etiqueta</legend>
                <Check id="lab-f-name" label="Nome do produto" checked={productFields.name} onChange={(v) => setProductFields({ ...productFields, name: v })} />
                <Check id="lab-f-price" label="Preço" checked={productFields.price} onChange={(v) => setProductFields({ ...productFields, price: v })} />
                <Check id="lab-f-barcode" label="Código de barras" checked={productFields.barcode} onChange={(v) => setProductFields({ ...productFields, barcode: v })} />
                <Check id="lab-f-code" label="Código em texto" checked={productFields.code} onChange={(v) => setProductFields({ ...productFields, code: v })} />
                <Check id="lab-f-company" label="Nome da empresa" checked={productFields.company} onChange={(v) => setProductFields({ ...productFields, company: v })} />
              </fieldset>
              {product && !product.barcode && productFields.barcode && (
                <div className="form-notice">
                  Este produto não tem código de barras.{" "}
                  {isManager ? (
                    <button type="button" className="btn-link" disabled={generating} onClick={() => void generateBarcode()}>
                      {generating ? "Gerando…" : "Gerar código EAN-13 e salvar no produto"}
                    </button>
                  ) : (
                    "Peça ao administrador para gerar o código, ou desmarque “Código de barras”."
                  )}
                </div>
              )}
            </>
          )}

          {mode === "free" && (
            <>
              <div className="field">
                <label htmlFor="lab-free-title">Título</label>
                <input id="lab-free-title" maxLength={60} autoComplete="off" value={free.title} onChange={setFreeField("title")} />
              </div>
              {(["line1", "line2", "line3"] as const).map((k, i) => (
                <div className="field" key={k}>
                  <label htmlFor={`lab-free-${k}`}>Linha {i + 1}</label>
                  <input id={`lab-free-${k}`} maxLength={60} autoComplete="off" value={free[k]} onChange={setFreeField(k)} />
                </div>
              ))}
              <div className="rec-form-row">
                <div className="field">
                  <label htmlFor="lab-free-price">Preço / valor</label>
                  <input id="lab-free-price" maxLength={20} autoComplete="off" placeholder="Ex.: R$ 9,90" value={free.price} onChange={setFreeField("price")} />
                </div>
                <div className="field">
                  <label htmlFor="lab-free-type">Tipo do código</label>
                  <select id="lab-free-type" value={free.barcodeType} onChange={(e) => setFree({ ...free, barcodeType: e.target.value as BarcodeType })}>
                    <option value="auto">Automático (EAN-13 só se válido)</option>
                    <option value="code128">CODE128</option>
                    <option value="ean13">EAN-13</option>
                  </select>
                </div>
              </div>
              <div className="field">
                <label htmlFor="lab-free-barcode">Código de barras (opcional)</label>
                <input id="lab-free-barcode" maxLength={40} autoComplete="off" value={free.barcode} onChange={setFreeField("barcode")} />
                <span className="field-hint">Deixe vazio para imprimir só texto.</span>
              </div>
              <div className="field">
                <label htmlFor="lab-free-extra">Texto adicional</label>
                <input id="lab-free-extra" maxLength={120} autoComplete="off" value={free.extra} onChange={setFreeField("extra")} />
              </div>
              <Check id="lab-free-company" label="Nome da empresa" checked={free.company} onChange={(v) => setFree({ ...free, company: v })} />
            </>
          )}

          {mode === "service_point" && (
            <>
              <div className="field">
                <label htmlFor="lab-point-search">Buscar comanda ou mesa</label>
                <input id="lab-point-search" type="search" autoComplete="off" placeholder="Código ou número" value={pointTerm} onChange={(e) => setPointTerm(e.target.value)} />
              </div>
              {point ? (
                <div className="cus-selected">
                  <span>
                    <strong>{point.displayName}</strong>
                    <small className="muted"> · {point.code} · {point.barcode ? "código de barras cadastrado" : "usa o código (CODE128)"}</small>
                  </span>
                  <button type="button" className="btn-secondary btn-auto" onClick={() => setPoint(null)}>
                    Trocar
                  </button>
                </div>
              ) : (
                <ul className="cus-options lab-points" aria-label="Comandas e mesas">
                  {points.length === 0 && <li className="field-hint lab-empty">Nenhuma comanda ou mesa encontrada.</li>}
                  {points.map((p) => (
                    <li key={p.id}>
                      <button type="button" className="cus-option" onClick={() => setPoint(p)}>
                        <span>{p.displayName}</span>
                        <small className="muted">{p.type === "table" ? "Mesa" : "Comanda"} · {p.code}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <fieldset className="print-destinations">
                <legend>O que aparece no cartão</legend>
                <Check id="lab-p-barcode" label="Código de barras" checked={pointFields.barcode} onChange={(v) => setPointFields({ ...pointFields, barcode: v })} />
                <Check id="lab-p-code" label="Código em texto" checked={pointFields.code} onChange={(v) => setPointFields({ ...pointFields, code: v })} />
                <Check id="lab-p-company" label="Nome da empresa" checked={pointFields.company} onChange={(v) => setPointFields({ ...pointFields, company: v })} />
              </fieldset>
            </>
          )}
        </section>

        <section className="sys-card lab-side">
          <div className="field">
            <label htmlFor="lab-printer">Impressora de etiquetas</label>
            <select id="lab-printer" value={printerId ?? ""} onChange={(e) => setPrinterId(e.target.value || null)} disabled={!printers || printers.length === 0}>
              {(printers ?? []).length === 0 && <option value="">Nenhuma impressora</option>}
              {(printers ?? []).length > 1 && !printerId && <option value="">Escolha…</option>}
              {(printers ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.widthMm}×{p.heightMm} mm{p.isDefault ? ", padrão" : ""}){p.isReady ? "" : " — sem agente"}
                </option>
              ))}
            </select>
            {printer && !printer.isReady && <span className="field-hint">Esta impressora ainda não está conectada ao Agente de Impressão.</span>}
          </div>
          <div className="field">
            <label htmlFor="lab-qty">Quantidade de etiquetas (máx. {max})</label>
            <input id="lab-qty" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/\D/g, "").slice(0, 3))} />
          </div>
          {content && printer ? (
            <LabelPreview content={content} geometry={geometryOf(printer)} quantity={qtyNumber} />
          ) : (
            <p className="field-hint lab-empty">{printer ? "A prévia aparece quando o conteúdo estiver preenchido." : "Escolha uma impressora para ver a prévia."}</p>
          )}
          <button className="btn-primary lab-print" type="button" disabled={printing || !printer} onClick={() => void print()}>
            {printing ? "Enviando…" : `Imprimir ${qtyNumber} ${qtyNumber === 1 ? "etiqueta" : "etiquetas"}`}
          </button>
          {isManager && (
            <Link className="field-hint" to="/app/configuracoes/impressao">
              Configurar impressoras
            </Link>
          )}
        </section>
      </div>
    </div>
  );
}
