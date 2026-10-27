import { useCallback, useEffect, useRef, useState } from "react";
import { formatReais } from "../../lib/money";
import type { CompanyRole } from "../../lib/types";
import { CustomerPicker } from "../customers/CustomerPicker";
import type { CustomerOption } from "../customers/customersLogic";
import { CartBar, CartPanel } from "../orders/Cart";
import { Catalog } from "../orders/Catalog";
import { ModifierDialog, type ModifierChoice } from "../modifiers/ModifierDialog";
import { supabaseOrdersSource, type OrdersSource } from "../orders/ordersApi";
import {
  MODIFIERS_LOAD_ERROR,
  addToCart,
  cartTotal,
  changeCartQuantity,
  decideAdd,
  removeCartItem,
  setCartItemNotes,
  toSubmitPayload,
  updateCartLine,
  type CartItem,
  type CatalogCategory,
  type CatalogProduct,
} from "../orders/ordersLogic";
import type { DeliverySource } from "./deliveryApi";
import {
  EMPTY_ADDRESS,
  FEE_SOURCE_LABEL,
  FULFILLMENT_LABEL,
  METHOD_LABEL,
  STEP_TITLE,
  TIMING_LABEL,
  addressFormProblem,
  buildCreateArgs,
  emptyDraft,
  feeWithRules,
  formatStatusShort,
  freeDeliveryApplies,
  freeDeliveryRemaining,
  minimumOrderProblem,
  formatAddressLine,
  formatCep,
  manualFeeMode,
  parseMoney,
  setMethod,
  stepProblem,
  stepsFor,
  switchFulfillment,
  timingOptions,
  type AddressForm,
  type AddressRow,
  type DeliveryQuote,
  type DeliveryRow,
  type ExpectedMethod,
  type Fulfillment,
  type NewOrderDraft,
  type PaymentTiming,
} from "./deliveryLogic";

const newRequestId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/[x]/g, () => Math.floor(Math.random() * 16).toString(16));

// Novo pedido de Delivery/Retirada em etapas. O que sai para o servidor é só: tipo, cliente, endereço (id), itens
// (ids/quantidade/observação/opções), taxa MANUAL (quando permitido), pagamento esperado e observações. Preço, taxa
// efetiva, previsão e total são sempre do backend; as exibições abaixo são estimativas informativas.
export function DeliveryNewOrder({
  companyId,
  role,
  source,
  ordersSource = supabaseOrdersSource,
  onClose,
  onCreated,
}: {
  companyId: string;
  role: CompanyRole | null;
  source: DeliverySource;
  ordersSource?: OrdersSource;
  onClose: () => void;
  onCreated: (deliveryOrderId: string) => void;
}) {
  const [draft, setDraft] = useState<NewOrderDraft>(() => emptyDraft("delivery"));
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [customerText, setCustomerText] = useState("");
  const [stepIndex, setStepIndex] = useState(0);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [pick, setPick] = useState<{ product: CatalogProduct; line: CartItem | null } | null>(null);
  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [imageUrls, setImageUrls] = useState<Map<string, string>>(new Map());
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<AddressRow[] | null>(null);
  const [addressForm, setAddressForm] = useState<{ id: string | null; form: AddressForm } | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [quote, setQuote] = useState<DeliveryQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [manualText, setManualText] = useState("");
  const [changeText, setChangeText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [rules, setRules] = useState<{ minOrder: number | null; freeAbove: number | null } | null>(null);
  const [history, setHistory] = useState<DeliveryRow[] | null>(null);
  const [created, setCreated] = useState<{ id: string; total: number } | null>(null);

  // client_request_id: UM por tentativa, preservado no retry. Qualquer mudança no conteúdo gera outro (senão o
  // servidor devolveria o pedido antigo — é a idempotência funcionando).
  const requestId = useRef(newRequestId());
  const submittingRef = useRef(false);
  const mutate = useCallback(<T,>(set: (fn: (prev: T) => T) => void, fn: (prev: T) => T) => {
    requestId.current = newRequestId();
    set(fn);
  }, []);
  const patchDraft = (fn: (d: NewOrderDraft) => NewOrderDraft) => mutate(setDraft, fn);
  const mutateCart = (fn: (c: CartItem[]) => CartItem[]) => mutate(setCart, fn);

  const steps = stepsFor(draft.fulfillment);
  const step = steps[Math.min(stepIndex, steps.length - 1)];
  const address = addresses?.find((a) => a.id === draft.addressId) ?? null;

  // catálogo (MESMO do atendimento)
  useEffect(() => {
    let live = true;
    void (async () => {
      const r = await ordersSource.loadCatalog(companyId);
      if (!live) return;
      if (!r.data) {
        setCatalogError(r.error);
        return;
      }
      setCategories(r.data.categories);
      setProducts(r.data.products);
      const paths = r.data.products.map((p) => p.imagePath).filter((p): p is string => !!p);
      if (paths.length) {
        const urls = await ordersSource.getImageUrls(paths);
        if (live) setImageUrls(urls);
      }
    })();
    return () => {
      live = false;
    };
  }, [ordersSource, companyId]);

  // endereços do cliente selecionado
  const customerId = draft.customerId;
  const reloadAddresses = useCallback(async () => {
    if (!customerId) {
      setAddresses(null);
      return;
    }
    const r = await source.addresses(customerId);
    setAddresses(r.data ?? []);
    if (r.error) setAddressError(r.error);
  }, [source, customerId]);
  useEffect(() => {
    void reloadAddresses();
  }, [reloadAddresses]);

  // taxa/previsão: consulta ao servidor quando o endereço/tipo muda (nunca calculada aqui)
  useEffect(() => {
    let live = true;
    setQuote(null);
    setQuoteError(null);
    if (draft.fulfillment === "delivery" && !address) return;
    void source.quote(companyId, draft.fulfillment, address?.city ?? null, address?.neighborhood ?? null).then((r) => {
      if (!live) return;
      if (r.data) setQuote(r.data);
      else setQuoteError(r.error);
    });
    return () => {
      live = false;
    };
  }, [source, companyId, draft.fulfillment, address]);

  // regras da empresa (pedido mínimo / entrega grátis): só orientação; o servidor confere de novo na confirmação
  useEffect(() => {
    let live = true;
    void source.settings(companyId).then((r) => {
      if (live && r.data) setRules({ minOrder: r.data.minOrderAmount, freeAbove: r.data.freeDeliveryAbove });
    });
    return () => {
      live = false;
    };
  }, [source, companyId]);

  // histórico do cliente selecionado (últimos pedidos)
  useEffect(() => {
    let live = true;
    setHistory(null);
    if (!customerId) return;
    void source.customerOrders(companyId, customerId).then((r) => {
      if (live) setHistory(r.data ?? []);
    });
    return () => {
      live = false;
    };
  }, [source, companyId, customerId]);

  const manualMode = manualFeeMode(quote, role);
  const manualParsed = manualText.trim() ? parseMoney(manualText) : null;
  const subtotal = cartTotal(cart);
  const freeAbove = rules?.freeAbove ?? null;
  const fee = feeWithRules(quote, draft.manualFee, subtotal, freeAbove);
  const total = subtotal + (fee ?? 0);
  const check = { draft, cartCount: cart.length, quote, role, total, subtotal, minOrder: rules?.minOrder ?? null };
  const problem = stepProblem(step, check);

  function chooseCustomer(c: CustomerOption | null) {
    setCustomer(c);
    patchDraft((d) => ({ ...d, customerId: c?.id ?? null, addressId: null, manualFee: null }));
    setAddresses(null);
  }

  function handleAdd(product: CatalogProduct) {
    const decision = decideAdd(product);
    if (decision === "blocked") {
      setCatalogError(MODIFIERS_LOAD_ERROR);
      return;
    }
    if (decision === "dialog") {
      setPick({ product, line: null });
      return;
    }
    mutateCart((c) => addToCart(c, product));
  }
  function confirmPick(choice: ModifierChoice) {
    if (!pick) return;
    const { product, line } = pick;
    setPick(null);
    if (line) mutateCart((c) => updateCartLine(c, line.lineId, choice));
    else mutateCart((c) => addToCart(c, product, choice));
  }

  async function saveAddress() {
    if (!addressForm || !customerId) return;
    const p = addressFormProblem(addressForm.form);
    if (p) {
      setAddressError(p);
      return;
    }
    setAddressError(null);
    const r = addressForm.id ? await source.updateAddress(addressForm.id, addressForm.form) : await source.createAddress(customerId, addressForm.form);
    if (!r.data) {
      setAddressError(r.error);
      return;
    }
    setAddressForm(null);
    await reloadAddresses();
    patchDraft((d) => ({ ...d, addressId: r.data.id, manualFee: null }));
  }

  async function deactivateAddress(a: AddressRow) {
    const r = await source.setAddressActive(a.id, false);
    if (r.error) {
      setAddressError(r.error);
      return;
    }
    if (draft.addressId === a.id) patchDraft((d) => ({ ...d, addressId: null }));
    await reloadAddresses();
  }

  async function confirm() {
    if (submittingRef.current) return; // duplo clique
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    const args = buildCreateArgs(companyId, requestId.current, draft, toSubmitPayload(cart), quote);
    const r = await source.create(args);
    submittingRef.current = false;
    setSubmitting(false);
    if (!r.data) {
      setSubmitError(r.error); // mantém o MESMO requestId: o retry é idempotente
      return;
    }
    setCreated({ id: r.data.deliveryOrderId, total: r.data.total });
  }

  const next = () => {
    if (problem) return;
    setStepIndex((i) => Math.min(i + 1, steps.length - 1));
  };
  const back = () => setStepIndex((i) => Math.max(i - 1, 0));

  const methods: ExpectedMethod[] = ["cash", "pix", "debit_card", "credit_card", "other"];
  const lastStep = step === "review";
  const customerLabel = draft.customerId ? (customer?.name ?? "Cliente cadastrado") : draft.customerName.trim();

  if (created) {
    return (
      <div className="dl-new dl-new-done" role="dialog" aria-modal="true" aria-label="Pedido criado">
        <div className="dl-new-panel">
          <h3>Pedido criado</h3>
          <p>
            {FULFILLMENT_LABEL[draft.fulfillment]} confirmado. Total <strong>{formatReais(created.total)}</strong>. Os itens já estão na produção.
          </p>
          <div className="modal-actions">
            <button type="button" className="btn-primary btn-auto" autoFocus onClick={() => onCreated(created.id)}>Voltar para o Delivery</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dl-new" role="dialog" aria-modal="true" aria-label="Novo pedido de Delivery">
      <div className="dl-new-panel">
        <div className="dl-new-head">
          <h3>Novo pedido</h3>
          <button type="button" className="btn-secondary btn-small" onClick={onClose}>Fechar</button>
        </div>
        <ol className="dl-steps" aria-label="Etapas">
          {steps.map((s, i) => (
            <li key={s} className={i === stepIndex ? "dl-step-current" : i < stepIndex ? "dl-step-done" : ""}>{STEP_TITLE[s]}</li>
          ))}
        </ol>

        <div className="dl-new-body">
          {step === "type" && (
            <div className="dl-type">
              {(["delivery", "pickup"] as Fulfillment[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`dl-type-btn${draft.fulfillment === f ? " dl-type-btn-on" : ""}`}
                  aria-pressed={draft.fulfillment === f}
                  onClick={() => patchDraft((d) => switchFulfillment(d, f))}
                >
                  <strong>{f === "delivery" ? "Entrega" : "Retirada no local"}</strong>
                  <span className="muted">{f === "delivery" ? "Cliente, endereço e taxa de entrega" : "Sem endereço e sem taxa"}</span>
                </button>
              ))}
            </div>
          )}

          {step === "customer" && (
            <div className="dl-block">
              <CustomerPicker
                companyId={companyId}
                inputId="dl-customer"
                label={draft.fulfillment === "delivery" ? "Cliente (obrigatório)" : "Cliente"}
                maxLength={80}
                text={customerText}
                onTextChange={(v) => {
                  setCustomerText(v);
                  if (draft.fulfillment === "pickup") patchDraft((d) => ({ ...d, customerName: v }));
                }}
                selected={customer}
                onSelect={chooseCustomer}
                autoFocus
              />
              {customerId && history && history.length > 0 && (
                <div className="dl-history" aria-label="Últimos pedidos do cliente">
                  <strong>Últimos pedidos deste cliente</strong>
                  <ul>
                    {history.map((h) => (
                      <li key={h.id}>
                        <span>{FULFILLMENT_LABEL[h.fulfillment]} · {new Date(h.createdAt).toLocaleDateString("pt-BR")}</span>
                        <span className="muted">{formatStatusShort(h)}</span>
                        <span>{formatReais(h.total)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {customerId && history && history.length === 0 && <p className="field-hint">Primeiro pedido deste cliente nos últimos 60 dias.</p>}
              <label className="dl-field">
                <span>Telefone para contato {draft.customerId ? "(opcional: o do cadastro é usado)" : "(opcional)"}</span>
                <input
                  inputMode="tel"
                  value={draft.customerPhone}
                  maxLength={20}
                  onChange={(e) => patchDraft((d) => ({ ...d, customerPhone: e.target.value }))}
                />
              </label>
            </div>
          )}

          {step === "address" && (
            <div className="dl-block">
              {addresses === null && <p className="muted">Carregando endereços…</p>}
              {addresses !== null && addresses.length === 0 && !addressForm && <p className="muted">Este cliente ainda não tem endereço. Cadastre o primeiro.</p>}
              {addresses?.map((a) => (
                <div key={a.id} className={`dl-addr${draft.addressId === a.id ? " dl-addr-on" : ""}`}>
                  <label className="dl-addr-main">
                    <input type="radio" name="dl-addr" checked={draft.addressId === a.id} onChange={() => patchDraft((d) => ({ ...d, addressId: a.id, manualFee: null }))} />
                    <span>
                      <strong>{a.label ?? "Endereço"}</strong>
                      <span className="dl-addr-line">{formatAddressLine({ street: a.street, number: a.number, complement: a.complement, neighborhood: a.neighborhood, city: a.city, state: a.state, cep: a.cep, reference: a.reference })}</span>
                      {a.cep && <span className="muted">CEP {formatCep(a.cep)}</span>}
                      {a.reference && <span className="muted">Ref.: {a.reference}</span>}
                    </span>
                  </label>
                  <span className="dl-addr-actions">
                    <button type="button" className="btn-secondary btn-small" onClick={() => setAddressForm({ id: a.id, form: { label: a.label ?? "", cep: a.cep ? formatCep(a.cep) : "", street: a.street, number: a.number ?? "", complement: a.complement ?? "", neighborhood: a.neighborhood, city: a.city, state: a.state, reference: a.reference ?? "" } })}>Editar</button>
                    <button type="button" className="btn-secondary btn-small" onClick={() => void deactivateAddress(a)}>Desativar</button>
                  </span>
                </div>
              ))}
              {addressError && <div className="form-error" role="alert">{addressError}</div>}
              {addressForm ? (
                <form className="dl-addr-form" onSubmit={(e) => { e.preventDefault(); void saveAddress(); }}>
                  {(
                    [
                      ["label", "Apelido (ex.: Casa)", 30], ["cep", "CEP", 9], ["street", "Rua", 120], ["number", "Número", 20],
                      ["complement", "Complemento", 60], ["neighborhood", "Bairro", 80], ["city", "Cidade", 80], ["state", "UF", 2], ["reference", "Ponto de referência", 120],
                    ] as Array<[keyof AddressForm, string, number]>
                  ).map(([k, l, max]) => (
                    <label key={k} className={`dl-field${k === "street" || k === "reference" ? " dl-field-wide" : ""}`}>
                      <span>{l}</span>
                      <input
                        value={addressForm.form[k]}
                        maxLength={max}
                        inputMode={k === "cep" ? "numeric" : undefined}
                        onChange={(e) => setAddressForm({ ...addressForm, form: { ...addressForm.form, [k]: k === "state" ? e.target.value.toUpperCase() : e.target.value } })}
                      />
                    </label>
                  ))}
                  <div className="modal-actions dl-field-wide">
                    <button type="button" className="btn-secondary" onClick={() => { setAddressForm(null); setAddressError(null); }}>Cancelar</button>
                    <button type="submit" className="btn-primary btn-auto">Salvar endereço</button>
                  </div>
                </form>
              ) : (
                <button type="button" className="btn-secondary" onClick={() => { setAddressError(null); setAddressForm({ id: null, form: { ...EMPTY_ADDRESS } }); }}>
                  Novo endereço
                </button>
              )}
            </div>
          )}

          {step === "products" && (
            <div className="dl-block dl-products">
              {catalogError && <div className="form-error" role="alert">{catalogError}</div>}
              <div className="order-body">
                <Catalog categories={categories} products={products} imageUrls={imageUrls} variant="attendant" onAdd={handleAdd} />
                <CartPanel
                  cart={cart}
                  imageUrls={imageUrls}
                  open={cartOpen}
                  submitting={false}
                  error={null}
                  notice={null}
                  onClose={() => setCartOpen(false)}
                  onIncrement={(id) => mutateCart((c) => changeCartQuantity(c, id, 1))}
                  onDecrement={(id) => mutateCart((c) => changeCartQuantity(c, id, -1))}
                  onRemove={(id) => mutateCart((c) => removeCartItem(c, id))}
                  onNotesChange={(id, notes) => mutateCart((c) => setCartItemNotes(c, id, notes))}
                  onEdit={(item) => {
                    const p = products.find((x) => x.id === item.productId);
                    return p && p.modifierGroups.length > 0 ? () => setPick({ product: p, line: item }) : null;
                  }}
                  onSubmit={() => {
                    setCartOpen(false);
                    next();
                  }}
                  submitLabel="Continuar"
                  hint="O preço cobrado é sempre conferido pelo servidor na confirmação."
                />
              </div>
              {draft.fulfillment === "delivery" && (minimumOrderProblem("delivery", subtotal, rules?.minOrder ?? null) || freeDeliveryRemaining("delivery", subtotal, freeAbove) !== null) && (
                <p className="field-hint dl-rules-hint" role="status">
                  {minimumOrderProblem("delivery", subtotal, rules?.minOrder ?? null) ?? ""}
                  {freeDeliveryRemaining("delivery", subtotal, freeAbove) !== null && ` Faltam ${formatReais(freeDeliveryRemaining("delivery", subtotal, freeAbove) ?? 0)} para entrega grátis.`}
                </p>
              )}
              {problem && <p className="dl-problem" role="status">{problem}</p>}
              <CartBar cart={cart} onOpen={() => setCartOpen(true)} />
              {pick && (
                <ModifierDialog
                  key={pick.line?.lineId ?? pick.product.id}
                  productName={pick.product.name}
                  basePrice={pick.product.salePrice}
                  groups={pick.product.modifierGroups}
                  mode={pick.line ? "edit" : "add"}
                  initial={pick.line ? { optionIds: pick.line.modifiers.map((m) => m.optionId), notes: pick.line.notes, quantity: pick.line.quantity } : undefined}
                  onConfirm={confirmPick}
                  onClose={() => setPick(null)}
                />
              )}
            </div>
          )}

          {step === "notes" && (
            <div className="dl-block">
              <label className="dl-field dl-field-wide">
                <span>Observações do pedido (opcional)</span>
                <textarea rows={4} maxLength={300} value={draft.notes} onChange={(e) => patchDraft((d) => ({ ...d, notes: e.target.value }))} />
              </label>
              {quote?.defaultInstructions && <p className="field-hint">Instrução padrão da empresa: {quote.defaultInstructions}</p>}
            </div>
          )}

          {step === "fee" && (
            <div className="dl-block">
              {quoteError && <div className="form-error" role="alert">{quoteError}</div>}
              {!quote && !quoteError && <p className="muted">Calculando taxa e previsão…</p>}
              {quote && (
                <>
                  {draft.fulfillment === "pickup" ? (
                    <p>Retirada: <strong>sem taxa</strong>. Previsão de retirada em <strong>{quote.estimatedMinutes} min</strong>.</p>
                  ) : (
                    <>
                      <p>
                        Taxa de entrega:{" "}
                        <strong>{fee === null ? "não cadastrada" : formatReais(fee)}</strong>
                        {draft.manualFee === null && freeDeliveryApplies(quote, draft.manualFee, subtotal, freeAbove) && <span className="muted"> ({FEE_SOURCE_LABEL.free}: pedido a partir de {formatReais(freeAbove ?? 0)})</span>}
                        {draft.manualFee === null && quote.feeSource !== "none" && !freeDeliveryApplies(quote, draft.manualFee, subtotal, freeAbove) && <span className="muted"> ({FEE_SOURCE_LABEL[quote.feeSource]}{quote.zoneName ? ` · ${quote.zoneName}` : ""})</span>}
                        {draft.manualFee !== null && <span className="muted"> ({FEE_SOURCE_LABEL.manual})</span>}
                      </p>
                      <p>Previsão de entrega: <strong>{quote.estimatedMinutes} min</strong></p>
                      {manualMode !== "hidden" && (
                        <label className="dl-field">
                          <span>{manualMode === "required" ? "Taxa manual (obrigatória: bairro sem taxa)" : "Ajustar taxa manualmente (opcional)"}</span>
                          <input
                            inputMode="decimal"
                            placeholder="0,00"
                            value={manualText}
                            onChange={(e) => {
                              setManualText(e.target.value);
                              const v = parseMoney(e.target.value);
                              patchDraft((d) => ({ ...d, manualFee: e.target.value.trim() === "" ? null : v }));
                            }}
                          />
                          {manualText.trim() && manualParsed === null && <span className="field-hint dl-bad">Valor inválido.</span>}
                        </label>
                      )}
                      {manualMode === "hidden" && quote.feeSource === "none" && (
                        <div className="form-error">Não há taxa cadastrada para este bairro e o ajuste manual está desativado. Peça a um administrador para cadastrar a zona.</div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {step === "payment" && (
            <div className="dl-block">
              <fieldset className="dl-fieldset">
                <legend>Quando será pago</legend>
                {timingOptions(draft.fulfillment).map((t: PaymentTiming) => (
                  <label key={t} className="dl-radio">
                    <input type="radio" name="dl-timing" checked={draft.paymentTiming === t} onChange={() => patchDraft((d) => ({ ...d, paymentTiming: t }))} />
                    {TIMING_LABEL[t]}
                  </label>
                ))}
              </fieldset>
              <fieldset className="dl-fieldset">
                <legend>Forma prevista</legend>
                <label className="dl-radio">
                  <input type="radio" name="dl-method" checked={draft.expectedMethod === null} onChange={() => { setChangeText(""); patchDraft((d) => setMethod(d, null)); }} />
                  Não informar
                </label>
                {methods.map((m) => (
                  <label key={m} className="dl-radio">
                    <input type="radio" name="dl-method" checked={draft.expectedMethod === m} onChange={() => { if (m !== "cash") setChangeText(""); patchDraft((d) => setMethod(d, m)); }} />
                    {METHOD_LABEL[m]}
                  </label>
                ))}
              </fieldset>
              {draft.expectedMethod === "cash" && (
                <label className="dl-field">
                  <span>Troco para (opcional)</span>
                  <input
                    inputMode="decimal"
                    placeholder="Ex.: 100,00"
                    value={changeText}
                    onChange={(e) => {
                      setChangeText(e.target.value);
                      patchDraft((d) => ({ ...d, cashChangeFor: e.target.value.trim() ? parseMoney(e.target.value) : null }));
                    }}
                  />
                  <span className="field-hint">Total estimado: {formatReais(total)}</span>
                </label>
              )}
            </div>
          )}

          {step === "review" && (
            <div className="dl-block dl-review">
              <dl className="dl-info">
                <div><dt>Tipo</dt><dd>{FULFILLMENT_LABEL[draft.fulfillment]}</dd></div>
                <div><dt>Cliente</dt><dd>{customerLabel || "—"}</dd></div>
                {draft.fulfillment === "delivery" && address && (
                  <div><dt>Endereço</dt><dd>{formatAddressLine({ street: address.street, number: address.number, complement: address.complement, neighborhood: address.neighborhood, city: address.city, state: address.state, cep: address.cep, reference: address.reference })}</dd></div>
                )}
                <div><dt>Previsão</dt><dd>{quote ? `${quote.estimatedMinutes} min` : "—"}</dd></div>
                <div><dt>Pagamento</dt><dd>{TIMING_LABEL[draft.paymentTiming]}{draft.expectedMethod ? ` · ${METHOD_LABEL[draft.expectedMethod]}` : ""}</dd></div>
                {draft.cashChangeFor !== null && <div><dt>Troco para</dt><dd>{formatReais(draft.cashChangeFor)}</dd></div>}
                {draft.notes.trim() && <div><dt>Observações</dt><dd>{draft.notes.trim()}</dd></div>}
              </dl>
              <ul className="dl-items">
                {cart.map((i) => (
                  <li key={i.lineId}>
                    <span className="dl-item-main"><strong>{i.quantity}×</strong> {i.name}</span>
                    {i.modifiers.length > 0 && <span className="dl-item-mods">{i.modifiers.map((m) => m.name).join(", ")}</span>}
                    {i.notes && <span className="dl-item-notes">Obs.: {i.notes}</span>}
                  </li>
                ))}
              </ul>
              <dl className="dl-totals">
                <div><dt>Subtotal</dt><dd>{formatReais(subtotal)}</dd></div>
                {draft.fulfillment === "delivery" && <div><dt>Taxa de entrega</dt><dd>{fee === null ? "—" : formatReais(fee)}</dd></div>}
                <div className="dl-total"><dt>Total estimado</dt><dd>{formatReais(total)}</dd></div>
              </dl>
              <p className="field-hint">Valores conferidos pelo servidor ao confirmar.</p>
              {submitError && <div className="form-error" role="alert">{submitError}</div>}
            </div>
          )}
        </div>

        <div className="dl-new-foot">
          {problem && step !== "products" && <span className="dl-problem" role="status">{problem}</span>}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={stepIndex === 0 ? onClose : back} disabled={submitting}>
              {stepIndex === 0 ? "Cancelar" : "Voltar"}
            </button>
            {lastStep ? (
              <button type="button" className="btn-primary btn-auto" disabled={submitting} onClick={() => void confirm()}>
                {submitting ? "Criando…" : "CONFIRMAR PEDIDO"}
              </button>
            ) : (
              <button type="button" className="btn-primary btn-auto" disabled={!!problem} onClick={next}>
                Avançar
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
