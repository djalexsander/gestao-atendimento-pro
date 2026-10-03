import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { BarcodeField } from "../../components/BarcodeField";
import { ProductStockPanel } from "../stock/ProductStockPanel";
import { ProductModifiersSection } from "../modifiers/ModifiersAdmin";
import { Modal } from "../employees/Modal";
import type { AdminCategory } from "./categoriesLogic";
import { ProductImageError, processProductImage, type ProcessedImage } from "./productImage";
import type { EditProduct, NewProduct } from "./productsApi";
import {
  BARCODE_MAX_LENGTH,
  CODE_MAX_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  NAME_MAX_LENGTH,
  buildCategoryOptions,
  buildProductSectorOptions,
  normalizeBarcode,
  normalizeCode,
  normalizeDescription,
  parsePrice,
  validateBarcode,
  validateCode,
  validateDescription,
  validateName,
  type AdminProduct,
} from "./productsLogic";
import type { AdminSector } from "./sectorsLogic";

// `onSubmit` devolve a mensagem de erro (ou null quando deu certo); quem fecha o diálogo em caso
// de sucesso é a tela. Mesmo contrato de CategoryDialogs.tsx/SectorDialogs.tsx.
type Submit<T> = (value: T) => Promise<string | null>;

function useSubmit() {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function run(validate: () => string | null, request: () => Promise<string | null>) {
    setError(null);
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setSubmitting(true);
    const failure = await request();
    setSubmitting(false);
    if (failure) setError(failure);
  }

  return { error, submitting, run };
}

function Actions({
  submitting,
  submitLabel,
  submittingLabel,
  danger,
  disabled,
  onClose,
}: {
  submitting: boolean;
  submitLabel: string;
  submittingLabel: string;
  danger?: boolean;
  disabled?: boolean;
  onClose: () => void;
}) {
  return (
    <div className="modal-actions">
      <button className="btn-secondary" type="button" disabled={submitting} onClick={onClose}>
        Cancelar
      </button>
      <button
        className={danger ? "btn-danger" : "btn-primary btn-auto"}
        type="submit"
        disabled={submitting || disabled}
      >
        {submitting ? submittingLabel : submitLabel}
      </button>
    </div>
  );
}

function ErrorBox({ message }: { message: string | null }) {
  return message ? <div className="form-error">{message}</div> : null;
}

// Botão "Escolher/Trocar foto" + "Remover foto" com preview/placeholder. Só cuida da SELEÇÃO do
// arquivo (input escondido) e do estado visual (busy/erro); o que fazer com o File escolhido é
// de quem usa (NewProductDialog estaciona local, EditPhotoField envia na hora — ver abaixo).
function PhotoPicker({
  previewUrl,
  busy,
  error,
  onFile,
  onClear,
  pickLabel,
}: {
  previewUrl: string | null;
  busy: boolean;
  error: string | null;
  onFile: (file: File) => void;
  onClear: (() => void) | null;
  pickLabel: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="field">
      <label>Foto do produto</label>
      <div className="photo-picker">
        {previewUrl ? (
          <img className="photo-preview" src={previewUrl} width={96} height={96} alt="Pré-visualização da foto do produto" />
        ) : (
          <div className="photo-placeholder" aria-hidden="true">
            Sem foto
          </div>
        )}
        <div className="photo-picker-actions">
          <button className="btn-secondary btn-small" type="button" disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? "Processando…" : pickLabel}
          </button>
          {onClear && (
            <button className="btn-secondary btn-small btn-danger-text" type="button" disabled={busy} onClick={onClear}>
              Remover foto
            </button>
          )}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // permite escolher o MESMO arquivo de novo (ex.: depois de "Remover")
          if (file) onFile(file);
        }}
      />
      {error && <div className="field-error">{error}</div>}
      <span className="field-hint">Opcional. JPEG, PNG ou WebP — redimensionada e convertida para WebP automaticamente.</span>
    </div>
  );
}

// Foto na EDIÇÃO: ao contrário do cadastro (que só estaciona o arquivo até o Cadastrar), aqui
// trocar/remover a foto é uma AÇÃO PRÓPRIA — envia/remove na hora, independente do restante do
// formulário (ver item 11 do pedido). `onUpload`/`onRemove` recarregam a lista no pai; quando
// terminam, a nova imageUrl chega como prop e substitui o preview local.
function EditPhotoField({
  imageUrl,
  onUpload,
  onRemove,
}: {
  imageUrl: string | null;
  onUpload: (blob: Blob) => Promise<string | null>;
  onRemove: () => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localPreview, setLocalPreview] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    setBusy(true);
    let processed: ProcessedImage | null = null;
    try {
      processed = await processProductImage(file);
      setLocalPreview(processed.previewUrl);
      const failure = await onUpload(processed.blob);
      if (failure) setError(failure);
    } catch (err) {
      setError(err instanceof ProductImageError ? err.message : "Não foi possível processar essa imagem.");
    } finally {
      if (processed) URL.revokeObjectURL(processed.previewUrl);
      setLocalPreview(null);
      setBusy(false);
    }
  }

  async function handleRemove() {
    setError(null);
    setBusy(true);
    const failure = await onRemove();
    if (failure) setError(failure);
    setBusy(false);
  }

  const preview = localPreview ?? imageUrl;
  return (
    <PhotoPicker
      previewUrl={preview}
      busy={busy}
      error={error}
      onFile={(file) => void handleFile(file)}
      onClear={preview ? () => void handleRemove() : null}
      pickLabel={preview ? "Trocar foto" : "Escolher foto"}
    />
  );
}

interface ProductFieldsState {
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  code: string;
  setCode: (v: string) => void;
  categoryId: string;
  setCategoryId: (v: string) => void;
  price: string;
  setPrice: (v: string) => void;
  sectorId: string | null;
  setSectorId: (v: string | null) => void;
}

// Campos compartilhados entre Novo/Editar produto (foto, código de barras e status ficam de
// fora: cada um tem sua própria lógica, diferente entre criar e editar — ver
// PhotoPicker/EditPhotoField, BarcodeField e ToggleProductDialog). `barcodeField` é um slot: cada
// diálogo injeta seu próprio <BarcodeField>, mas a ORDEM visual (Categoria -> barras -> Preço)
// continua definida aqui, num lugar só.
function ProductFields({
  state,
  categories,
  currentCategoryId,
  sectors,
  currentSectorId,
  idPrefix,
  barcodeField,
}: {
  state: ProductFieldsState;
  categories: AdminCategory[];
  currentCategoryId: string | null;
  sectors: AdminSector[];
  currentSectorId: string | null;
  idPrefix: string;
  barcodeField: ReactNode;
}) {
  const categoryOptions = buildCategoryOptions(categories, currentCategoryId);
  const sectorOptions = buildProductSectorOptions(sectors, currentSectorId);
  const selectedCategory = categories.find((c) => c.id === state.categoryId) ?? null;

  return (
    <>
      <div className="field">
        <label htmlFor={`${idPrefix}-name`}>Nome</label>
        <input
          id={`${idPrefix}-name`}
          type="text"
          required
          maxLength={NAME_MAX_LENGTH}
          autoComplete="off"
          placeholder="Espeto de alcatra"
          value={state.name}
          onChange={(e) => state.setName(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-description`}>Descrição</label>
        <textarea
          id={`${idPrefix}-description`}
          rows={2}
          maxLength={DESCRIPTION_MAX_LENGTH}
          placeholder="Espeto de alcatra temperado com receita da casa."
          value={state.description}
          onChange={(e) => state.setDescription(e.target.value)}
        />
        <span className="field-hint">
          {state.description.length} / {DESCRIPTION_MAX_LENGTH}
        </span>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-code`}>Código</label>
        <input
          id={`${idPrefix}-code`}
          type="text"
          required
          maxLength={CODE_MAX_LENGTH}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="ESPETO-ALCATRA"
          value={state.code}
          onChange={(e) => state.setCode(e.target.value.toUpperCase())}
        />
        <span className="field-hint">Único na empresa. Letras maiúsculas, números, - e _.</span>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-category`}>Categoria</label>
        <select id={`${idPrefix}-category`} required value={state.categoryId} onChange={(e) => state.setCategoryId(e.target.value)}>
          <option value="" disabled>
            Selecione…
          </option>
          {categoryOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      {barcodeField}
      <div className="field">
        <label htmlFor={`${idPrefix}-price`}>Preço de venda</label>
        <div className="price-input">
          <span className="price-prefix">R$</span>
          <input
            id={`${idPrefix}-price`}
            type="text"
            inputMode="decimal"
            required
            placeholder="18,00"
            value={state.price}
            onChange={(e) => state.setPrice(e.target.value)}
          />
        </div>
      </div>
      <fieldset className="field sector-radio-group">
        <legend>Setor de produção</legend>
        {sectorOptions.map((opt) => (
          <label key={opt.id ?? "default"} className="radio-row">
            <input type="radio" name={`${idPrefix}-sector`} checked={state.sectorId === opt.id} onChange={() => state.setSectorId(opt.id)} />
            {opt.label}
          </label>
        ))}
        {state.sectorId === null && selectedCategory && !selectedCategory.default_sector && (
          <span className="field-hint">Esta categoria não possui setor padrão.</span>
        )}
      </fieldset>
    </>
  );
}

// Confirmação da REGENERAÇÃO (só aparece quando o produto já tem um código): mesmo texto e
// mesmo contrato onConfirm/onClose dos outros diálogos de confirmação (ex.: ToggleProductDialog).
// Espelha RegenerateConfirmDialog de ServicePointAdminDialogs.tsx, só troca o texto.
function RegenerateConfirmDialog({
  onConfirm,
  onClose,
}: {
  onConfirm: () => Promise<string | null>;
  onClose: () => void;
}) {
  const { error, submitting, run } = useSubmit();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void run(() => null, onConfirm);
  }

  return (
    <Modal title="Gerar novo EAN-13" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <p className="modal-text">
          Gerar um novo código invalidará o código de barras físico anterior deste produto. Deseja continuar?
        </p>
        <ErrorBox message={error} />
        <Actions submitting={submitting} submitLabel="Gerar novo código" submittingLabel="Gerando…" onClose={onClose} />
      </form>
    </Modal>
  );
}

// NOVO produto. A foto (se houver) e o EAN-13 (se marcado) só são enviados/gerados DEPOIS de o
// produto existir (precisam do id) — onSubmit recebe o Blob já processado e a intenção de gerar
// EAN, e decide (ver ProductsAdmin.tsx: cria, e só então envia a foto/gera o EAN; se qualquer um
// dos dois falhar o produto continua criado, com aviso para tentar de novo na edição).
export function NewProductDialog({
  categories,
  sectors,
  existingCodes,
  existingBarcodes,
  onSubmit,
  onClose,
}: {
  categories: AdminCategory[];
  sectors: AdminSector[];
  existingCodes: Set<string>;
  existingBarcodes: Set<string>;
  onSubmit: (input: NewProduct, pendingImage: ProcessedImage | null, generateEan: boolean) => Promise<string | null>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [code, setCode] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [barcode, setBarcode] = useState("");
  const [generateEan, setGenerateEan] = useState(false);
  const [price, setPrice] = useState("");
  const [sectorId, setSectorId] = useState<string | null>(null);
  const [active, setActive] = useState(true);
  const [pendingImage, setPendingImage] = useState<ProcessedImage | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const { error, submitting, run } = useSubmit();

  // Revoga a URL local anterior sempre que pendingImage muda (troca ou remoção) E quando o
  // diálogo fecha (cancelar ou depois de cadastrar) — um único lugar cuida da limpeza.
  useEffect(() => {
    return () => {
      if (pendingImage) URL.revokeObjectURL(pendingImage.previewUrl);
    };
  }, [pendingImage]);

  async function handleFile(file: File) {
    setImageError(null);
    setImageBusy(true);
    try {
      setPendingImage(await processProductImage(file));
    } catch (err) {
      setImageError(err instanceof ProductImageError ? err.message : "Não foi possível processar essa imagem.");
    } finally {
      setImageBusy(false);
    }
  }

  function clearImage() {
    setPendingImage(null);
    setImageError(null);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const normalizedCode = normalizeCode(code);
    const normalizedBarcode = normalizeBarcode(barcode);
    const parsedPrice = parsePrice(price);
    void run(
      () =>
        validateName(name.trim()) ??
        validateCode(normalizedCode) ??
        (existingCodes.has(normalizedCode) ? "Já existe um produto com este código." : null) ??
        (categoryId ? null : "Informe a categoria.") ??
        (generateEan ? null : validateBarcode(barcode.trim())) ??
        (!generateEan && normalizedBarcode && existingBarcodes.has(normalizedBarcode)
          ? "Já existe um produto com este código de barras."
          : null) ??
        validateDescription(description) ??
        parsedPrice.error,
      () =>
        onSubmit(
          {
            category_id: categoryId,
            name: name.trim(),
            description: normalizeDescription(description),
            code: normalizedCode,
            barcode: generateEan ? null : normalizedBarcode,
            sale_price: parsedPrice.value ?? 0,
            production_sector_id: sectorId,
            is_active: active,
          },
          pendingImage,
          generateEan,
        ),
    );
  }

  return (
    <Modal title="Novo produto" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <ErrorBox message={error} />
        <PhotoPicker
          previewUrl={pendingImage?.previewUrl ?? null}
          busy={imageBusy}
          error={imageError}
          onFile={(file) => void handleFile(file)}
          onClear={pendingImage ? clearImage : null}
          pickLabel={pendingImage ? "Trocar foto" : "Escolher foto"}
        />
        <ProductFields
          state={{ name, setName, description, setDescription, code, setCode, categoryId, setCategoryId, price, setPrice, sectorId, setSectorId }}
          categories={categories}
          currentCategoryId={null}
          sectors={sectors}
          currentSectorId={null}
          idPrefix="product-new"
          barcodeField={
            <BarcodeField
              id="product-new-barcode"
              maxLength={BARCODE_MAX_LENGTH}
              value={generateEan ? "" : barcode}
              onChange={setBarcode}
              disabled={generateEan}
              placeholder={generateEan ? "Será gerado ao salvar" : undefined}
              hint={generateEan ? "Um código EAN-13 será gerado automaticamente ao salvar." : undefined}
              action={{ label: generateEan ? "Cancelar geração" : "Gerar EAN-13", onClick: () => setGenerateEan((g) => !g) }}
            />
          }
        />
        <label className="checkbox-row">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Ativo
        </label>
        <Actions submitting={submitting} submitLabel="Cadastrar" submittingLabel="Cadastrando…" onClose={onClose} />
      </form>
    </Modal>
  );
}

// EDITAR: nome, descrição, código, categoria, barcode, preço e setor (o banco permite editar
// todos; ver productsApi.ts). Status fica por ação própria (ToggleProductDialog); foto também
// (EditPhotoField, envia/remove na hora — ver comentário acima).
export function EditProductDialog({
  product,
  categories,
  sectors,
  existingCodes,
  existingBarcodes,
  imageUrl,
  onSubmit,
  onUploadImage,
  onRemoveImage,
  onGenerateEan,
  onStockChanged,
  onClose,
}: {
  onStockChanged?: () => void;
  product: AdminProduct;
  categories: AdminCategory[];
  sectors: AdminSector[];
  existingCodes: Set<string>;
  existingBarcodes: Set<string>;
  imageUrl: string | null;
  onSubmit: Submit<EditProduct>;
  onUploadImage: (blob: Blob) => Promise<string | null>;
  onRemoveImage: () => Promise<string | null>;
  onGenerateEan: (regenerate: boolean) => Promise<{ barcode: string | null; error: string | null }>;
  onClose: () => void;
}) {
  const [name, setName] = useState(product.name);
  const [description, setDescription] = useState(product.description ?? "");
  const [code, setCode] = useState(product.code);
  const [categoryId, setCategoryId] = useState(product.category_id);
  const [barcode, setBarcode] = useState(product.barcode ?? "");
  const [price, setPrice] = useState(product.sale_price.toFixed(2).replace(".", ","));
  const [sectorId, setSectorId] = useState<string | null>(product.production_sector_id);
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);
  const { error, submitting, run } = useSubmit();

  // Gera direto (sem confirmação): só chamado quando o campo está vazio. Escreve no banco
  // imediatamente (é o que generate_product_ean13 faz); "Salvar" nem precisa ser clicado.
  async function generateDirect() {
    setGenBusy(true);
    setGenError(null);
    const result = await onGenerateEan(false);
    setGenBusy(false);
    if (result.error) {
      setGenError(result.error);
      return;
    }
    setBarcode(result.barcode ?? "");
  }

  // Regenera (com confirmação prévia, ver RegenerateConfirmDialog): mesmo formato Promise<string
  // | null> dos outros onConfirm deste arquivo.
  async function regenerate(): Promise<string | null> {
    setGenBusy(true);
    const result = await onGenerateEan(true);
    setGenBusy(false);
    if (result.error) return result.error;
    setBarcode(result.barcode ?? "");
    return null;
  }

  function handleGenerateClick() {
    if (barcode.trim()) setConfirmingRegenerate(true);
    else void generateDirect();
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const normalizedCode = normalizeCode(code);
    const normalizedBarcode = normalizeBarcode(barcode);
    const parsedPrice = parsePrice(price);
    void run(
      () =>
        validateName(name.trim()) ??
        validateCode(normalizedCode) ??
        (normalizedCode !== product.code && existingCodes.has(normalizedCode) ? "Já existe um produto com este código." : null) ??
        (categoryId ? null : "Informe a categoria.") ??
        validateBarcode(barcode.trim()) ??
        (normalizedBarcode && normalizedBarcode !== product.barcode && existingBarcodes.has(normalizedBarcode)
          ? "Já existe um produto com este código de barras."
          : null) ??
        validateDescription(description) ??
        parsedPrice.error,
      () =>
        onSubmit({
          category_id: categoryId,
          name: name.trim(),
          description: normalizeDescription(description),
          code: normalizedCode,
          barcode: normalizedBarcode,
          sale_price: parsedPrice.value ?? 0,
          production_sector_id: sectorId,
        }),
    );
  }

  return (
    <Modal title="Editar produto" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <ErrorBox message={error} />
        <EditPhotoField imageUrl={imageUrl} onUpload={onUploadImage} onRemove={onRemoveImage} />
        <ProductFields
          state={{ name, setName, description, setDescription, code, setCode, categoryId, setCategoryId, price, setPrice, sectorId, setSectorId }}
          categories={categories}
          currentCategoryId={product.category_id}
          sectors={sectors}
          currentSectorId={product.production_sector_id}
          idPrefix="product-edit"
          barcodeField={
            <BarcodeField
              id="product-edit-barcode"
              maxLength={BARCODE_MAX_LENGTH}
              value={barcode}
              onChange={setBarcode}
              hint={genBusy ? "Gerando…" : undefined}
              action={{ label: barcode.trim() ? "Gerar novo EAN-13" : "Gerar EAN-13", onClick: handleGenerateClick, disabled: genBusy }}
            />
          }
        />
        <ErrorBox message={genError} />
        <ProductModifiersSection productId={product.id} />
        <ProductStockPanel
          productId={product.id}
          productName={product.name}
          initial={{
            stock_control: product.stock_control,
            stock_quantity: product.stock_quantity,
            minimum_stock_quantity: product.minimum_stock_quantity,
            available_for_sale: product.available_for_sale,
          }}
          onChanged={onStockChanged}
        />
        <Actions submitting={submitting} submitLabel="Salvar" submittingLabel="Salvando…" onClose={onClose} />
      </form>
      {confirmingRegenerate && (
        <RegenerateConfirmDialog
          onConfirm={async () => {
            const failure = await regenerate();
            if (!failure) setConfirmingRegenerate(false);
            return failure;
          }}
          onClose={() => setConfirmingRegenerate(false)}
        />
      )}
    </Modal>
  );
}

// ATIVAR / DESATIVAR (nunca exclui). Não mexe em categoria nem setor.
export function ToggleProductDialog({
  product,
  onConfirm,
  onClose,
}: {
  product: AdminProduct;
  onConfirm: () => Promise<string | null>;
  onClose: () => void;
}) {
  const activating = !product.is_active;
  const { error, submitting, run } = useSubmit();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void run(() => null, onConfirm);
  }

  return (
    <Modal title={activating ? "Ativar" : "Desativar"} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <p className="modal-text">
          {activating ? (
            <>
              Ativar <strong>{product.name}</strong> ({product.code})? Ele volta a aparecer no catálogo operacional.
            </>
          ) : (
            <>
              Desativar <strong>{product.name}</strong> ({product.code})? O produto deixará de aparecer no catálogo
              operacional enquanto estiver inativo. Nada é apagado e você pode ativar de novo.
            </>
          )}
        </p>
        <ErrorBox message={error} />
        <Actions
          submitting={submitting}
          submitLabel={activating ? "Ativar" : "Desativar"}
          submittingLabel={activating ? "Ativando…" : "Desativando…"}
          danger={!activating}
          onClose={onClose}
        />
      </form>
    </Modal>
  );
}
