"use client";

import { useActionState } from "react";

import type { CampaignRow, Reach } from "../../lib/api";
import { enviarCampana } from "./actions";

const fecha = new Intl.DateTimeFormat("es-PY", { day: "numeric", month: "short" });

export function Composer({ token, reach }: { token: string; reach: Reach | null }) {
  const [state, action, pending] = useActionState(enviarCampana, {});

  return (
    <form action={action} className="panel composer">
      <input type="hidden" name="token" value={token} />

      <label>
        Título
        <input name="header" maxLength={60} placeholder="2x1 en tragos" required />
      </label>

      <label>
        Mensaje
        <textarea name="body" maxLength={300} rows={3} placeholder="Hasta las 12, solo hoy." required />
      </label>

      {reach ? <Alcance reach={reach} /> : null}

      {state?.error ? <p className="error">{state.error}</p> : null}
      {state?.ok ? <p className="ok">Campaña enviada. Abajo vas a ver qué llegó.</p> : null}

      <button type="submit" disabled={pending}>
        {pending ? "Enviando…" : "Enviar campaña"}
      </button>
    </form>
  );
}

/**
 * El medidor de alcance real.
 *
 * Sin esto, el comercio asume que le llega a todos sus clientes y toma
 * decisiones sobre un número falso. Nunca se le habla de "cupo de 3 avisos por
 * tarjeta cada 24 h": se le muestra la consecuencia, que es a cuántos les entra.
 */
function Alcance({ reach }: { reach: Reach }) {
  const porcentaje = reach.total > 0 ? Math.round((reach.reachable / reach.total) * 100) : 0;

  return (
    <div className="reach">
      <div className="reach-bar">
        <div className="reach-fill" style={{ width: `${porcentaje}%` }} />
      </div>
      <p>
        De tus <strong>{reach.total}</strong> clientes, hoy le llega a{" "}
        <strong>{reach.reachable}</strong>.
      </p>
      {reach.unreachable > 0 ? (
        <p className="cond">
          {reach.unreachable} ya recibieron varios avisos hoy o se dieron de baja. Les
          va a llegar mañana si repetís la campaña.
        </p>
      ) : null}
    </div>
  );
}

export function Historial({ campaigns }: { campaigns: CampaignRow[] }) {
  if (campaigns.length === 0) {
    return (
      <div className="panel">
        <p className="hint" style={{ margin: 0 }}>
          Todavía no enviaste ninguna campaña.
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      {campaigns.map((c) => (
        <div className="rule" key={c.id}>
          <div>
            <strong>{c.header}</strong>
            <span className="cond"> · {fecha.format(new Date(c.created_at))}</span>
          </div>
          <div className="cond">{c.body}</div>
          <div className="entrega">
            {/* Se reporta entregado y suprimido por separado, nunca un "enviado"
                plano: son cosas distintas y confundirlas infla el alcance. */}
            <span className="ok-pill">{c.delivered} entregados</span>
            {c.pending > 0 ? <span className="pill">{c.pending} en cola</span> : null}
            {c.suppressed > 0 ? (
              <span className="warn-pill">{c.suppressed} no entraron</span>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
