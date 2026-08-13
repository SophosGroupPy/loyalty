"use client";

import { useActionState, useState } from "react";

import type { SettingsView } from "../../lib/api";
import { guardarAjustes } from "./actions";

const HORAS = Array.from({ length: 24 }, (_, h) => h);

const hora = (h: number) => `${String(h).padStart(2, "0")}:00`;

export function EditorAjustes({
  token,
  inicial,
}: {
  token: string;
  inicial: SettingsView;
}) {
  const [state, action, pending] = useActionState(guardarAjustes, {});
  const [silencio, setSilencio] = useState(inicial.quietHours !== null);
  const [corte, setCorte] = useState(inicial.dayBoundaryHour);

  return (
    <form action={action} className="panel composer">
      <input type="hidden" name="token" value={token} />

      {/* ------------------------------------------------------------------ */}
      <h3>Cuándo termina tu día</h3>
      <p className="cond" style={{ margin: 0 }}>
        Si cerrás pasada la medianoche, poné la hora en que realmente termina tu
        jornada. Con el corte a las {hora(corte)}, un consumo de la 1 de la
        mañana cuenta como parte del día anterior — que es la noche que vos y tu
        cliente consideran una sola.
      </p>

      <label style={{ maxWidth: 220 }}>
        Corte del día
        <select
          name="dayBoundaryHour"
          value={corte}
          onChange={(e) => setCorte(Number(e.target.value))}
        >
          {HORAS.map((h) => (
            <option key={h} value={h}>
              {h === 0 ? "Medianoche (00:00)" : hora(h)}
            </option>
          ))}
        </select>
      </label>

      {/* ------------------------------------------------------------------ */}
      <h3 style={{ marginTop: "0.5rem" }}>Horario sin avisos</h3>
      <p className="cond" style={{ margin: 0 }}>
        Franja en la que no se manda ninguna notificación. Un restaurante suele
        callar de noche; un local nocturno, de día. Lo que quede afuera de esa
        franja se envía normalmente.
      </p>

      <label className="toggle-row" style={{ maxWidth: 340 }}>
        <span>No molestar en una franja</span>
        <input
          type="checkbox"
          name="silencio"
          checked={silencio}
          onChange={(e) => setSilencio(e.target.checked)}
        />
      </label>

      {silencio ? (
        <div className="fila" style={{ maxWidth: 340 }}>
          <label style={{ flex: 1 }}>
            Desde
            <select name="quietFrom" defaultValue={inicial.quietHours?.from ?? 22}>
              {HORAS.map((h) => (
                <option key={h} value={h}>
                  {hora(h)}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: 1 }}>
            Hasta
            <select name="quietTo" defaultValue={inicial.quietHours?.to ?? 9}>
              {HORAS.map((h) => (
                <option key={h} value={h}>
                  {hora(h)}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      <h3 style={{ marginTop: "0.5rem" }}>Topes de acumulación</h3>
      <p className="cond" style={{ margin: 0 }}>
        Acotan cuánto puede sumar una tarjeta. Sirven contra el uso indebido —
        por ejemplo, alguien pasando su tarjeta en cada consumo de una mesa
        entera. Dejalos vacíos si no querés límite.
      </p>

      <div className="fila" style={{ maxWidth: 340 }}>
        <label style={{ flex: 1 }}>
          Por consumo
          <input
            name="capPerEvent"
            type="number"
            min={1}
            defaultValue={inicial.caps.perEvent ?? ""}
            placeholder="sin límite"
          />
        </label>
        <label style={{ flex: 1 }}>
          Por día
          <input
            name="capPerDay"
            type="number"
            min={1}
            defaultValue={inicial.caps.perDay ?? ""}
            placeholder="sin límite"
          />
        </label>
      </div>

      {/* ------------------------------------------------------------------ */}
      <h3 style={{ marginTop: "0.5rem" }}>Vencimiento</h3>
      <p className="cond" style={{ margin: 0 }}>
        A los cuántos meses vencen los puntos sin usar. Vacío significa que no
        vencen nunca — cómodo para el cliente, pero el pasivo que acumulás no
        deja de crecer.
      </p>

      <label style={{ maxWidth: 220 }}>
        Meses
        <input
          name="expiryMonths"
          type="number"
          min={1}
          max={120}
          defaultValue={inicial.expiryMonths ?? ""}
          placeholder="no vencen"
        />
      </label>

      {state?.error ? <p className="error">{state.error}</p> : null}
      {state?.ok ? <p className="ok">Ajustes guardados.</p> : null}

      <button type="submit" disabled={pending}>
        {pending ? "Guardando…" : "Guardar ajustes"}
      </button>
    </form>
  );
}
