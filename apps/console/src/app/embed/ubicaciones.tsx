"use client";

import { useActionState } from "react";

import type { LocationRow } from "../../lib/api";
import { agregarUbicacion, quitarUbicacion } from "./actions";

export function NuevaUbicacion({ token, restantes }: { token: string; restantes: number }) {
  const [state, action, pending] = useActionState(agregarUbicacion, {});

  if (restantes <= 0) {
    return (
      <div className="panel aviso">
        Llegaste al máximo de 10 ubicaciones. Es el tope que impone Apple por
        pase, no una decisión nuestra. Para agregar otra tenés que quitar una —
        conviene dejar las más cercanas a donde vive tu clientela.
      </div>
    );
  }

  return (
    <form action={action} className="panel composer">
      <input type="hidden" name="token" value={token} />

      <label>
        Sucursal
        <input name="label" maxLength={60} placeholder="Villa Morra" required />
      </label>

      <label>
        Ubicación
        <input name="coords" placeholder="-25.2965, -57.5759" required />
        <span className="cond">
          Pegá el link de Google Maps del local, o hacé clic derecho sobre el
          punto en el mapa y copiá el par de números que aparece.
        </span>
      </label>

      <label>
        Mensaje al pasar cerca <span className="cond">(opcional)</span>
        <input
          name="relevantText"
          maxLength={80}
          placeholder="Estás cerca — mostrá tu tarjeta y sumá puntos"
        />
        <span className="cond">
          Es lo que ve el cliente en la pantalla bloqueada al acercarse.
        </span>
      </label>

      {state?.error ? <p className="error">{state.error}</p> : null}
      {state?.ok ? <p className="ok">Ubicación agregada.</p> : null}

      <button type="submit" disabled={pending}>
        {pending ? "Agregando…" : "Agregar ubicación"}
      </button>
    </form>
  );
}

export function ListaUbicaciones({
  token,
  locations,
}: {
  token: string;
  locations: LocationRow[];
}) {
  if (locations.length === 0) {
    return (
      <div className="panel">
        <p style={{ marginTop: 0 }}>Todavía no cargaste ninguna ubicación.</p>
        <p className="hint" style={{ marginBottom: 0 }}>
          Sin ubicaciones tus clientes no reciben el aviso al pasar por la
          puerta, que es el único canal que no gasta cupo de notificaciones.
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      {locations.map((l) => (
        <div className="rule toggle-row" key={l.id}>
          <div>
            <strong>{l.label}</strong>
            <div className="cond">
              {l.latitude.toFixed(4)}, {l.longitude.toFixed(4)}
            </div>
            {l.relevant_text ? (
              <div className="entrega">
                <span className="pill">{l.relevant_text}</span>
              </div>
            ) : (
              <div className="cond">Sin mensaje: se muestra solo la tarjeta.</div>
            )}
          </div>

          <form action={quitarUbicacion}>
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="id" value={l.id} />
            <button type="submit" className="linkish">
              Quitar
            </button>
          </form>
        </div>
      ))}
    </div>
  );
}
