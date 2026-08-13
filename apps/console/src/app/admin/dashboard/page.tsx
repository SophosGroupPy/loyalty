import { redirect } from "next/navigation";

import {
  fetchHealth,
  fetchMerchants,
  fetchOverview,
  type Health,
  type MerchantRow,
} from "../../../lib/admin";
import { logout } from "../actions";

const numero = new Intl.NumberFormat("es-PY");

const TABS = [
  { id: "resumen", label: "Resumen" },
  { id: "salud", label: "Salud" },
  { id: "comercios", label: "Comercios" },
] as const;

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const tab = (await searchParams).tab ?? "resumen";
  const overview = await fetchOverview();

  // Sin sesión válida no se muestra un error: se vuelve al login. Un token
  // vencido es lo normal después de ocho horas, no una falla.
  if (!overview) redirect("/admin");

  const totales = overview.products.reduce(
    (acc, p) => ({
      merchants: acc.merchants + p.merchants,
      cards: acc.cards + p.cards,
      outstanding: acc.outstanding + p.outstanding,
    }),
    { merchants: 0, cards: 0, outstanding: 0 },
  );

  return (
    <main className="shell">
      <header className="top">
        <h1>Sophos Loyalty</h1>
        <form action={logout}>
          <button type="submit" className="linkish">
            Cerrar sesión
          </button>
        </form>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <a key={t.id} className={t.id === tab ? "on" : ""} href={`?tab=${t.id}`}>
            {t.label}
          </a>
        ))}
      </nav>

      {tab === "resumen" ? (
        <section>
          <div className="cards">
            <div className="stat">
              <div className="n">{overview.products.length}</div>
              <div className="label">Productos</div>
            </div>
            <div className="stat">
              <div className="n">{numero.format(totales.merchants)}</div>
              <div className="label">Comercios</div>
            </div>
            <div className="stat">
              <div className="n">{numero.format(totales.cards)}</div>
              <div className="label">Tarjetas</div>
            </div>
            <div className="stat">
              <div className="n">{numero.format(totales.outstanding)}</div>
              <div className="label">Puntos en circulación</div>
              <div className="note">Pasivo agregado de todo el ecosistema.</div>
            </div>
          </div>

          <h2>Por producto</h2>
          <div className="panel">
            <table>
              <thead>
                <tr>
                  <th>Producto</th>
                  <th className="num">Comercios</th>
                  <th className="num">Con programa</th>
                  <th className="num">Tarjetas</th>
                  <th className="num">Puntos</th>
                </tr>
              </thead>
              <tbody>
                {overview.products.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.name}</strong>
                      <span className="cond"> · {p.slug}</span>
                    </td>
                    <td className="num">{numero.format(p.merchants)}</td>
                    <td className="num">
                      {numero.format(p.active_programs)}
                      {/* Un comercio dado de alta pero sin programa configurado
                          es un onboarding a medio terminar: nadie puede sumar
                          puntos ahí todavía. */}
                      {p.merchants > p.active_programs ? (
                        <span className="warn"> · {p.merchants - p.active_programs} sin configurar</span>
                      ) : null}
                    </td>
                    <td className="num">{numero.format(p.cards)}</td>
                    <td className="num">{numero.format(p.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {overview.identityGraph ? (
            <>
              <h2 style={{ marginTop: "1.75rem" }}>Grafo de identidad</h2>
              <div className="panel">
                <p className="hint" style={{ marginTop: 0 }}>
                  Es lo único que ningún comercio puede replicar por su cuenta:
                  una persona que ya se verificó en un local del ecosistema se da
                  de alta en el siguiente con un toque.
                </p>
                <div className="cards" style={{ marginBottom: 0 }}>
                  <div className="stat">
                    <div className="n">{numero.format(overview.identityGraph.people)}</div>
                    <div className="label">Personas</div>
                  </div>
                  <div className="stat">
                    <div className="n">{numero.format(overview.identityGraph.multi)}</div>
                    <div className="label">En más de un comercio</div>
                  </div>
                  <div className="stat">
                    <div className="n">{numero.format(overview.identityGraph.cross_product)}</div>
                    <div className="label">En más de un producto</div>
                    <div className="note">Cruzan de gastronomía a vida nocturna.</div>
                  </div>
                </div>
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      {tab === "salud" ? <Salud /> : null}
      {tab === "comercios" ? <Comercios /> : null}
    </main>
  );
}

async function Salud() {
  const health = await fetchHealth();
  if (!health) redirect("/admin");

  const filas: { label: string; value: number; bad: boolean; note: string }[] = [
    {
      label: "Pases desfasados",
      value: health.passes.drifted,
      bad: health.passes.drifted > 0,
      note: "El saldo de la tarjeta no coincide con el del ledger. Se reconcilian solos; si no baja, Google está rechazando.",
    },
    {
      label: "Pases con error",
      value: health.passes.errored,
      bad: health.passes.errored > 0,
      note: "Última sincronización fallida. Mirar last_error en pass_instance.",
    },
    {
      label: "Webhooks pendientes",
      value: health.webhooks.pending,
      bad: false,
      note: "En cola. Normal si el worker corre cada pocos minutos.",
    },
    {
      label: "Webhooks agotados",
      value: health.webhooks.exhausted,
      bad: health.webhooks.exhausted > 0,
      note: "Cinco intentos fallidos. El producto nunca se enteró: su POS no va a mostrar esos beneficios.",
    },
    {
      label: "Avisos suprimidos por cupo",
      value: health.notifications.suppressed,
      bad: false,
      note: "Llegaron al tope de 3 por tarjeta cada 24 h. Esperable; si crece mucho, algún comercio está saturando.",
    },
  ];

  return (
    <section>
      <h2>Qué está roto ahora</h2>
      <div className="panel">
        {filas.map((f) => (
          <div className="rule" key={f.label}>
            <div>
              <span className={f.bad ? "bad" : ""}>{numero.format(f.value)}</span> — {f.label}
            </div>
            <div className="cond">{f.note}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

async function Comercios() {
  const data = await fetchMerchants();
  if (!data) redirect("/admin");

  const porProducto = new Map<string, MerchantRow[]>();
  for (const m of data.merchants) {
    porProducto.set(m.product, [...(porProducto.get(m.product) ?? []), m]);
  }

  return (
    <section>
      {[...porProducto.entries()].map(([producto, merchants]) => (
        <div key={producto} style={{ marginBottom: "1.75rem" }}>
          <h2>{producto}</h2>
          <div className="panel">
            <table>
              <thead>
                <tr>
                  <th>Comercio</th>
                  <th>Programa</th>
                  <th className="num">Tarjetas</th>
                  <th className="num">Puntos</th>
                </tr>
              </thead>
              <tbody>
                {merchants.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <strong>{m.display_name}</strong>
                      <span className="cond"> · {m.external_id}</span>
                    </td>
                    <td>
                      {m.program_kind ? (
                        m.program_kind === "stamps" ? "Sellos" : "Puntos"
                      ) : (
                        <span className="warn">Sin configurar</span>
                      )}
                    </td>
                    <td className="num">{numero.format(m.cards)}</td>
                    <td className="num">{numero.format(m.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {data.merchants.length === 0 ? (
        <div className="panel">
          <p className="hint" style={{ margin: 0 }}>
            Todavía no hay comercios dados de alta.
          </p>
        </div>
      ) : null}
    </section>
  );
}
