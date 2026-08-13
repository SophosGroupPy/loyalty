"use client";

import { useActionState } from "react";

import type { RewardRow } from "../../lib/api";
import { cambiarEstadoBeneficio, crearBeneficio } from "./actions";

const numero = new Intl.NumberFormat("es-PY");

export function NuevoBeneficio({ token, unit }: { token: string; unit: string }) {
  const [state, action, pending] = useActionState(crearBeneficio, {});

  return (
    <form action={action} className="panel composer">
      <input type="hidden" name="token" value={token} />

      <div className="fila">
        <label style={{ flex: 2 }}>
          Beneficio
          <input name="name" maxLength={80} placeholder="Café gratis" required />
        </label>
        <label style={{ flex: 1 }}>
          Cuesta ({unit})
          <input name="cost" type="number" min={1} placeholder="10" required />
        </label>
      </div>

      <label>
        Condiciones <span className="cond">(opcional)</span>
        <input name="terms" maxLength={200} placeholder="No acumulable con otras promos" />
      </label>

      {state?.error ? <p className="error">{state.error}</p> : null}
      {state?.ok ? <p className="ok">Beneficio agregado.</p> : null}

      <button type="submit" disabled={pending}>
        {pending ? "Agregando…" : "Agregar beneficio"}
      </button>
    </form>
  );
}

export function ListaBeneficios({
  token,
  rewards,
  members,
  unit,
}: {
  token: string;
  rewards: RewardRow[];
  members: number;
  unit: string;
}) {
  if (rewards.length === 0) {
    return (
      <div className="panel">
        <p style={{ marginTop: 0 }}>Todavía no cargaste ningún beneficio.</p>
        <p className="hint" style={{ marginBottom: 0 }}>
          Sin beneficios tus clientes acumulan puntos que no pueden usar para
          nada. Es el motivo más común por el que un programa deja de funcionar.
        </p>
      </div>
    );
  }

  const activos = rewards.filter((r) => r.status === "active");
  const archivados = rewards.filter((r) => r.status === "archived");
  const alcanzables = activos.filter((r) => r.can_afford > 0).length;

  return (
    <>
      {/* Si nadie llega a nada, el programa está roto y el comercio no tiene
          forma de darse cuenta hasta que los clientes dejan de volver. */}
      {members > 0 && activos.length > 0 && alcanzables === 0 ? (
        <div className="panel aviso">
          Ninguno de tus {members} clientes llega todavía al beneficio más
          barato. Si pasa mucho tiempo así, conviene bajar el costo o revisar
          cuántos puntos das por consumo.
        </div>
      ) : null}

      <div className="panel">
        {activos.map((r) => (
          <Fila key={r.id} reward={r} token={token} members={members} unit={unit} />
        ))}
        {activos.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            No tenés beneficios activos.
          </p>
        ) : null}
      </div>

      {archivados.length > 0 ? (
        <>
          <h2 style={{ marginTop: "1.75rem" }}>Archivados</h2>
          <div className="panel">
            {archivados.map((r) => (
              <Fila key={r.id} reward={r} token={token} members={members} unit={unit} />
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

function Fila({
  reward,
  token,
  members,
  unit,
}: {
  reward: RewardRow;
  token: string;
  members: number;
  unit: string;
}) {
  const archivado = reward.status === "archived";

  return (
    <div className="rule toggle-row">
      <div>
        <div>
          <strong>{reward.name}</strong>
          <span className="cond">
            {" "}
            · {numero.format(reward.cost)} {unit}
          </span>
        </div>
        {reward.terms ? <div className="cond">{reward.terms}</div> : null}
        <div className="entrega">
          {!archivado && members > 0 ? (
            <span className={reward.can_afford > 0 ? "ok-pill" : "warn-pill"}>
              {reward.can_afford} de {members} ya pueden canjearlo
            </span>
          ) : null}
          {reward.redemptions > 0 ? (
            <span className="pill">{reward.redemptions} canjes</span>
          ) : null}
        </div>
      </div>

      <form action={cambiarEstadoBeneficio}>
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="id" value={reward.id} />
        <input type="hidden" name="status" value={archivado ? "active" : "archived"} />
        <button type="submit" className="linkish">
          {archivado ? "Reactivar" : "Archivar"}
        </button>
      </form>
    </div>
  );
}
