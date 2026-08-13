import QRCode from "qrcode";

import {
  fetchCampaigns,
  fetchEnrollmentLink,
  fetchNotifications,
  fetchProgram,
  fetchReach,
  fetchSummary,
  type ProgramView,
} from "../../lib/api";
import { guardarAvisos } from "./actions";
import { Composer, Historial } from "./campanas";

const TABS = [
  { id: "resumen", label: "Resumen" },
  { id: "programa", label: "Programa" },
  { id: "notificaciones", label: "Notificaciones" },
  { id: "difusion", label: "Difusión" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const DAYS: Record<string, string> = {
  mon: "lunes",
  tue: "martes",
  wed: "miércoles",
  thu: "jueves",
  fri: "viernes",
  sat: "sábado",
  sun: "domingo",
};

const EVENTS: Record<string, string> = {
  "order.paid": "cada consumo",
  "ticket.validated": "cada entrada al local",
  "table.reserved": "cada reserva de mesa",
  "invoice.issued": "cada factura emitida",
};

const guaranies = new Intl.NumberFormat("es-PY");

/** "1 puntos" delata que el texto lo armó una máquina y no alguien que lo leyó. */
function unidad(n: number, plural: string): string {
  return n === 1 ? plural.replace(/s$/, "") : plural;
}

/**
 * Traduce una regla del motor a castellano.
 *
 * El comercio no tiene por qué entender el JSON de configuración; si la consola
 * no traduce, la sección "Programa" no le sirve para verificar que su programa
 * quedó como él quería.
 */
function describeRule(rule: NonNullable<ProgramView["config"]["earn"]>[number], unit: string) {
  const on = EVENTS[rule.on] ?? rule.on;
  const parts: string[] = [];

  if (rule.rate) {
    parts.push(
      `${rule.rate.points} ${unidad(rule.rate.points, unit)} por cada ` +
        `${guaranies.format(rule.rate.per)} Gs`,
    );
  }
  const fixed = rule.points ?? rule.stamps;
  if (fixed) {
    parts.push(`${fixed} ${unidad(fixed, unit)} ${fixed === 1 ? "fijo" : "fijos"}`);
  }
  if (rule.multiplier) parts.push(`multiplica por ${rule.multiplier}`);

  const conditions: string[] = [];
  if (rule.when?.weekday?.length) {
    conditions.push(rule.when.weekday.map((d) => DAYS[d] ?? d).join(", "));
  }
  if (rule.when?.hour?.length) {
    conditions.push(`de ${Math.min(...rule.when.hour)} a ${Math.max(...rule.when.hour) + 1} h`);
  }
  if (rule.minTotal) conditions.push(`desde ${guaranies.format(rule.minTotal)} Gs`);

  return {
    main: `${parts.join(" + ") || "sin acumulación"} — ${on}`,
    condition: conditions.join(" · "),
  };
}

export default async function EmbedPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; tab?: string }>;
}) {
  const params = await searchParams;
  const token = params.token;
  const tab = (TABS.find((t) => t.id === params.tab)?.id ?? "resumen") as TabId;

  if (!token) {
    return (
      <main className="shell">
        <div className="error-box">Falta el token de sesión.</div>
      </main>
    );
  }

  const summary = await fetchSummary(token);

  // Un token vencido es el caso normal, no un error del sistema: la consola
  // puede quedar abierta más de una hora. El mensaje tiene que decirle al
  // comercio qué hacer, no mostrarle un fallo.
  if (!summary) {
    return (
      <main className="shell">
        <div className="error-box">
          <p>Tu sesión venció.</p>
          <p className="hint">Volvé a abrir el módulo de fidelidad desde el menú.</p>
        </div>
      </main>
    );
  }

  const unit = "puntos";

  return (
    <main className="shell">
      <header className="top">
        <h1>Programa de fidelidad</h1>
        <span className="who">{summary.merchant.displayName}</span>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <a
            key={t.id}
            className={t.id === tab ? "on" : ""}
            href={`?token=${encodeURIComponent(token)}&tab=${t.id}`}
          >
            {t.label}
          </a>
        ))}
      </nav>

      {tab === "resumen" ? <Resumen summary={summary} /> : null}
      {tab === "programa" ? <Programa token={token} unit={unit} /> : null}
      {tab === "notificaciones" ? <Notificaciones token={token} /> : null}
      {tab === "difusion" ? <Difusion token={token} /> : null}
    </main>
  );
}

function Resumen({ summary }: { summary: NonNullable<Awaited<ReturnType<typeof fetchSummary>>> }) {
  return (
    <section>
      <div className="cards">
        <div className="stat">
          <div className="n">{summary.cards}</div>
          <div className="label">Tarjetas emitidas</div>
        </div>
        <div className="stat">
          <div className="n">{summary.active_cards}</div>
          <div className="label">Activas</div>
        </div>
        <div className="stat">
          <div className="n">{summary.new_this_week}</div>
          <div className="label">Nuevas esta semana</div>
        </div>
        <div className="stat">
          <div className="n">{summary.redemptions}</div>
          <div className="label">Canjes</div>
        </div>
        <div className="stat">
          <div className="n">{guaranies.format(summary.outstanding)}</div>
          <div className="label">Puntos en circulación</div>
          {/* Es el pasivo del comercio: lo que debe en beneficios si todos sus
              clientes canjearan mañana. Suele ser el número que nadie le muestra
              y el que más le conviene mirar. */}
          <div className="note">Lo que deberías si todos canjearan hoy.</div>
        </div>
      </div>
    </section>
  );
}

async function Programa({ token, unit }: { token: string; unit: string }) {
  const program = await fetchProgram(token);

  if (!program) {
    return (
      <section>
        <div className="panel">
          <p>Todavía no configuraste tu programa.</p>
          <p className="hint">
            Definí cómo suman puntos tus clientes y qué pueden canjear.
          </p>
        </div>
      </section>
    );
  }

  const { config } = program;

  return (
    <section>
      <h2>Cómo suman tus clientes</h2>
      <div className="panel">
        {(config.earn ?? []).map((rule, i) => {
          const described = describeRule(rule, unit);
          return (
            <div className="rule" key={i}>
              <div>{described.main}</div>
              {described.condition ? (
                <div className="cond">Solo {described.condition}</div>
              ) : null}
            </div>
          );
        })}
      </div>

      {config.tiers?.length ? (
        <>
          <h2 style={{ marginTop: "1.75rem" }}>Niveles</h2>
          <div className="panel">
            {config.tiers.map((tier) => (
              <div className="rule" key={tier.name}>
                {tier.name} — desde {guaranies.format(tier.min)} {unit}
              </div>
            ))}
          </div>
        </>
      ) : null}

      {config.caps?.perDay || config.caps?.perEvent ? (
        <>
          <h2 style={{ marginTop: "1.75rem" }}>Topes</h2>
          <div className="panel">
            {config.caps.perEvent ? (
              <div className="rule">Máximo {config.caps.perEvent} {unit} por consumo</div>
            ) : null}
            {config.caps.perDay ? (
              <div className="rule">Máximo {config.caps.perDay} {unit} por día</div>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

async function Notificaciones({ token }: { token: string }) {
  const [settings, reach, historial] = await Promise.all([
    fetchNotifications(token),
    fetchReach(token),
    fetchCampaigns(token),
  ]);

  if (!settings) {
    return (
      <section>
        <div className="panel">
          <p style={{ margin: 0 }}>Configurá tu programa antes de mandar avisos.</p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2>Avisos automáticos</h2>
      <form action={guardarAvisos} className="panel">
        <input type="hidden" name="token" value={token} />
        {settings.kinds.map((k) => (
          <div className="rule toggle-row" key={k.id}>
            <div>
              <div>{k.label}</div>
              <div className="cond">{k.description}</div>
            </div>
            <label className="switch">
              <input type="hidden" name="kind" value={k.id} />
              <input
                type="checkbox"
                name="enabled"
                value={k.id}
                defaultChecked={k.enabled}
              />
            </label>
          </div>
        ))}
        <button type="submit" className="secondary">
          Guardar
        </button>
      </form>

      <h2 style={{ marginTop: "1.75rem" }}>Nueva campaña</h2>
      <Composer token={token} reach={reach} />

      <h2 style={{ marginTop: "1.75rem" }}>Enviadas</h2>
      <Historial campaigns={historial?.campaigns ?? []} />
    </section>
  );
}

async function Difusion({ token }: { token: string }) {
  const link = await fetchEnrollmentLink(token);
  if (!link) return null;

  // El QR se genera en el servidor: así no hace falta traer una librería al
  // navegador ni pedirle la imagen a un servicio externo, que además metería
  // la URL del comercio en los logs de un tercero.
  const qr = await QRCode.toDataURL(link.url, { margin: 1, width: 512 });

  return (
    <section>
      <h2>Para que tus clientes se sumen</h2>
      <div className="panel">
        <div className="qr-row">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr} alt={`Código QR para sumarse al programa de ${link.displayName}`} />
          <div>
            <p>
              Imprimí este código y ponelo en las mesas, en el mostrador o en la
              puerta. Quien lo escanee se suma en menos de un minuto.
            </p>
            <p className="hint" style={{ marginBottom: "0.5rem" }}>
              También podés compartir el link directo:
            </p>
            <code className="url">{link.url}</code>
          </div>
        </div>
      </div>
    </section>
  );
}
