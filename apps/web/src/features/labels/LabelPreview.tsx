import { columnX, layoutLabel, planSheet, type LabelContent, type LabelGeometry } from "./labelLayout.ts";

// Prévia APROXIMADA (SVG em milímetros) com o MESMO motor de layout do Agente: textos, código de barras, organização
// e a quantidade de colunas. A 1ª linha física é desenhada; a última (incompleta) aparece com as colunas vazias esmaecidas.
export function LabelPreview({ content, geometry, quantity }: { content: LabelContent; geometry: LabelGeometry; quantity: number }) {
  const layout = layoutLabel(content, geometry);
  const plan = planSheet(quantity, geometry);
  const shown = Math.min(plan.columns, Math.max(1, quantity));
  const pad = 2;
  const width = plan.sheetWidthMm + pad * 2;
  const height = geometry.heightMm + pad * 2;

  return (
    <div className="lab-preview">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Prévia da etiqueta" preserveAspectRatio="xMidYMid meet">
        <rect x={0} y={0} width={width} height={height} className="lab-sheet" />
        {Array.from({ length: plan.columns }, (_, c) => {
          const ox = pad + columnX(c, geometry);
          const used = c < shown;
          return (
            <g key={c} transform={`translate(${ox} ${pad})`} opacity={used ? 1 : 0.3}>
              <rect x={0} y={0} width={geometry.widthMm} height={geometry.heightMm} rx={1} className="lab-label" />
              {used &&
                layout.elements.map((e, i) =>
                  e.kind === "text" ? (
                    <text
                      key={i}
                      x={e.align === "center" ? e.x + e.w / 2 : e.align === "right" ? e.x + e.w : e.x}
                      y={e.y + e.h * 0.78}
                      fontSize={e.fontMm}
                      fontWeight={e.bold ? 700 : 400}
                      textAnchor={e.align === "center" ? "middle" : e.align === "right" ? "end" : "start"}
                      className="lab-text"
                    >
                      {e.text}
                    </text>
                  ) : (
                    <g key={i} className="lab-bars">
                      {barRuns(e.modules).map(([start, len]) => (
                        <rect key={start} x={e.x + start * e.moduleMm} y={e.y} width={len * e.moduleMm} height={e.h} />
                      ))}
                    </g>
                  ),
                )}
            </g>
          );
        })}
      </svg>
      <p className="field-hint">
        {geometry.widthMm} × {geometry.heightMm} mm · {plan.columns} {plan.columns === 1 ? "coluna" : "colunas"} · {quantity} {quantity === 1 ? "etiqueta" : "etiquetas"} em {plan.rows}{" "}
        {plan.rows === 1 ? "linha" : "linhas"}. Prévia aproximada.
      </p>
      {layout.warnings.length > 0 && (
        <ul className="lab-warnings" role="status">
          {layout.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Sequências de barras pretas contínuas: [início, comprimento] em módulos.
function barRuns(modules: boolean[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  modules.forEach((on, i) => {
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      runs.push([start, i - start]);
      start = -1;
    }
  });
  if (start >= 0) runs.push([start, modules.length - start]);
  return runs;
}
