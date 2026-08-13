"use client";

import { useActionState, useState } from "react";

import type { CardDesignView } from "../../lib/api";
import { guardarDiseno } from "./actions";

/**
 * Luminancia relativa según WCAG, para calcular contraste.
 *
 * Existe porque el error más caro de esta pantalla no da ningún mensaje de
 * error: un comercio elige fondo claro, deja el texto en blanco, guarda, y sus
 * clientes reciben una tarjeta donde el saldo no se lee. Nadie se entera hasta
 * que alguien se queja.
 */
function luminancia(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const canales = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * canales[0]! + 0.7152 * canales[1]! + 0.0722 * canales[2]!;
}

function contraste(a: string, b: string): number {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

export function EditorDiseno({
  token,
  inicial,
  merchantName,
}: {
  token: string;
  inicial: CardDesignView;
  merchantName: string;
}) {
  const [state, action, pending] = useActionState(guardarDiseno, {});
  const [d, setD] = useState(inicial);

  const set = (k: keyof CardDesignView) => (v: string) => setD((p) => ({ ...p, [k]: v }));

  const ratio = contraste(d.backgroundColor, d.foregroundColor);
  const ilegible = ratio < 3;

  return (
    <div className="disenio">
      <form action={action} className="panel composer">
        <input type="hidden" name="token" value={token} />
        {Object.entries(d).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}

        <h3>Lo que ven en las dos</h3>

        <label>
          Nombre del programa
          <input
            value={d.programName}
            onChange={(e) => set("programName")(e.target.value)}
            maxLength={60}
          />
        </label>

        <label>
          Logo <span className="cond">URL pública, cuadrada</span>
          <input
            value={d.logoUrl}
            onChange={(e) => set("logoUrl")(e.target.value)}
            placeholder="https://…/logo.png"
          />
        </label>

        <div className="fila">
          <label style={{ flex: 1 }}>
            Fondo
            <ColorInput value={d.backgroundColor} onChange={set("backgroundColor")} />
          </label>
          <label style={{ flex: 1 }}>
            Etiqueta del saldo
            <input
              value={d.balanceLabel}
              onChange={(e) => set("balanceLabel")(e.target.value)}
              maxLength={20}
            />
          </label>
        </div>

        <h3 style={{ marginTop: "0.5rem" }}>Solo Apple</h3>
        <p className="cond" style={{ margin: 0 }}>
          Google decide el color del texto solo. Apple exige elegirlo, y ahí es
          donde una tarjeta puede quedar ilegible.
        </p>

        <div className="fila">
          <label style={{ flex: 1 }}>
            Texto
            <ColorInput value={d.foregroundColor} onChange={set("foregroundColor")} />
          </label>
          <label style={{ flex: 1 }}>
            Etiquetas
            <ColorInput value={d.labelColor} onChange={set("labelColor")} />
          </label>
        </div>

        {ilegible ? (
          <p className="aviso-inline">
            El texto casi no se distingue del fondo (contraste {ratio.toFixed(1)}:1).
            Tus clientes no van a poder leer su saldo. Conviene 4.5:1 o más.
          </p>
        ) : null}

        <label>
          Texto junto al logo <span className="cond">(opcional)</span>
          <input
            value={d.logoText}
            onChange={(e) => set("logoText")(e.target.value)}
            maxLength={30}
            placeholder={merchantName}
          />
        </label>

        <label>
          Campo de novedades
          <input
            value={d.newsLabel}
            onChange={(e) => set("newsLabel")(e.target.value)}
            maxLength={20}
            required
          />
          <span className="cond">
            Podés renombrarlo, no quitarlo: en Apple es el único lugar por donde
            entra un aviso. Sacarlo dejaría la tarjeta muda.
          </span>
        </label>

        {state?.error ? <p className="error">{state.error}</p> : null}
        {state?.ok ? <p className="ok">Diseño guardado.</p> : null}

        <button type="submit" disabled={pending}>
          {pending ? "Guardando…" : "Guardar diseño"}
        </button>
      </form>

      <div className="previews">
        <Preview plataforma="Google Wallet" d={d} merchantName={merchantName} google />
        <Preview plataforma="Apple Wallet" d={d} merchantName={merchantName} />
        <p className="cond">
          Aproximaciones. El formato real lo define cada plataforma y no se puede
          mover nada de lugar — es un formulario, no un lienzo.
        </p>
      </div>
    </div>
  );
}

function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <span className="color-input">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        maxLength={7}
      />
    </span>
  );
}

function Preview({
  plataforma,
  d,
  merchantName,
  google = false,
}: {
  plataforma: string;
  d: CardDesignView;
  merchantName: string;
  google?: boolean;
}) {
  // Google elige el color del texto por su cuenta según el fondo, así que la
  // previsualización tiene que hacer lo mismo. Pintarlo siempre blanco haría
  // creer que la tarjeta de Google quedó ilegible cuando en realidad no lo
  // está — y llevaría al comercio a cambiar un color que no tenía problema.
  const claro = luminancia(d.backgroundColor) > 0.45;
  const texto = google ? (claro ? "#202124" : "#FFFFFF") : d.foregroundColor;
  const etiqueta = google ? (claro ? "#202124B3" : "#FFFFFFB3") : d.labelColor;

  return (
    <div className="preview-wrap">
      <div className="preview-label">{plataforma}</div>
      <div className="tarjeta" style={{ background: d.backgroundColor, color: texto }}>
        <div className="tarjeta-top">
          {d.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={d.logoUrl} alt="" />
          ) : (
            <div className="logo-vacio" />
          )}
          <span>{google ? merchantName : d.logoText || merchantName}</span>
        </div>

        <div className="tarjeta-nombre">{d.programName}</div>

        <div className="tarjeta-saldo">
          <div style={{ color: etiqueta }}>{d.balanceLabel}</div>
          <div className="n">340</div>
        </div>

        {!google ? (
          <div className="tarjeta-novedades" style={{ color: etiqueta }}>
            {d.newsLabel}
          </div>
        ) : null}

        <div className="tarjeta-qr" />
      </div>
    </div>
  );
}
