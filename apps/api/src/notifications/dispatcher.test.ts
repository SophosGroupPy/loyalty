/**
 * Verificación del despachador.
 *
 * Los criterios del plan: seis acumulaciones seguidas tienen que producir **un
 * solo** aviso, con el resto registrado y explicable; y cuando el cupo escasea,
 * lo que se cae es la campaña y nunca el aviso transaccional.
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, rows, type Db } from "@sophos/db";
import { zonedParts } from "@sophos/rules";

import { hashSecret } from "../auth.js";
import { createServer } from "../server.js";
import {
  campaignReport,
  dispatchDue,
  enqueue,
  NoInstalledPassError,
  type NotificationSender,
  type RenderedNotification,
} from "./dispatcher.js";
import { CAMPAIGN_BUDGET, DAILY_BUDGET } from "./policy.js";

const SIGNING_KEY = new TextEncoder().encode("test-signing-key");

/**
 * Paraguay está en UTC-3 todo el año.
 *   2026-08-13T02:00:00Z → miércoles 23:00 en Asunción
 *   2026-08-13T15:00:00Z → jueves    12:00 en Asunción
 */
const NOCHE = new Date("2026-08-13T02:00:00Z");
const MEDIODIA = new Date("2026-08-13T15:00:00Z");

let db: Db;
let app: FastifyInstance;
let token: string;

/** Sender que registra lo que le mandan, sin salir a ningún lado. */
function recordingSender() {
  const sent: RenderedNotification[] = [];
  const sender: NotificationSender = {
    async send(notification) {
      sent.push(notification);
    },
  };
  return { sender, sent };
}

beforeEach(async () => {
  db = await createTestDb();
  await rows(
    db.drizzle,
    sql`INSERT INTO product (slug, name, client_id, client_secret_hash)
        VALUES ('elmenu', 'ElMenu', 'cid', ${await hashSecret("sec")})`,
  );

  // El reloj se fija al mismo instante con el que se despacha. Sin esto, lo que
  // se encola por HTTP queda agendado con la hora real de la máquina y el test
  // pasa o falla según el día en que se corra.
  app = createServer({ db, signingKey: SIGNING_KEY, now: () => NOCHE });
  await app.ready();

  const res = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: { grant_type: "client_credentials", client_id: "cid", client_secret: "sec" },
  });
  token = res.json().access_token;
});

afterEach(async () => {
  await app.close();
  await db.close();
});

function call(method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload: payload as object } : {}),
  });
}

/** Comercio + programa + una tarjeta. `notifications` va a la config del programa. */
async function seed(notifications?: Record<string, unknown>): Promise<string> {
  await call("POST", "/v1/merchants", {
    externalId: "r-1",
    slug: "don-julio",
    legalName: "Don Julio SA",
    displayName: "Don Julio",
  });
  await call("PUT", "/v1/programs", {
    merchant: "r-1",
    kind: "points",
    config: {
      earn: [{ on: "order.paid", rate: { per: 10_000, points: 1 } }],
      ...(notifications ? { notifications } : {}),
    },
  });

  const card = await call("POST", "/v1/memberships", {
    merchant: "r-1",
    phone: "0993427654",
    displayName: "Ana",
    phoneVerified: true,
  });
  return card.json().membershipId;
}

async function merchantId(): Promise<string> {
  const found = await rows<{ id: string }>(
    db.drizzle,
    sql`SELECT id FROM merchant WHERE external_id = 'r-1'`,
  );
  return found[0]!.id;
}

/** Campaña real: la notificación tiene FK contra `campaign`. */
async function makeCampaign(merchant: string, header = "Promo"): Promise<string> {
  const created = await rows<{ id: string }>(
    db.drizzle,
    sql`INSERT INTO campaign (merchant_id, header, body, created_by)
        VALUES (${merchant}, ${header}, 'x', 'staff:1') RETURNING id`,
  );
  return created[0]!.id;
}

/** Estado de todas las notificaciones de una tarjeta. */
async function statuses(membershipId: string) {
  return rows<{ kind: string; sent_at: string | null; suppressed_reason: string | null }>(
    db.drizzle,
    sql`SELECT kind, sent_at, suppressed_reason FROM notification
        WHERE membership_id = ${membershipId} ORDER BY created_at`,
  );
}

// ---------------------------------------------------------------------------

describe("sin pase instalado", () => {
  it("se registra como no_installed_pass, no como send_failed", async () => {
    // Una tarjeta a la que nadie agregó el pase en ninguna wallet no es un fallo
    // de envío: es que no hay dónde entregar. El reporte tiene que distinguirlo,
    // o el comercio lee "falló" cuando la verdad es "no la agregaron".
    const membershipId = await seed();
    const merchant = await merchantId();
    await enqueue(db, {
      membershipId,
      merchantId: merchant,
      kind: "campaign",
      campaignId: await makeCampaign(merchant),
      header: "Promo",
      body: "x",
      now: NOCHE,
    });

    const sender: NotificationSender = {
      async send() {
        throw new NoInstalledPassError();
      },
    };
    const report = await dispatchDue(db, sender, { now: NOCHE });

    expect(report.suppressed.no_installed_pass).toBe(1);
    expect(report.suppressed.send_failed).toBeUndefined();

    const [n] = await statuses(membershipId);
    expect(n?.suppressed_reason).toBe("no_installed_pass");
    expect(n?.sent_at).toBeNull();
  });
});

describe("agrupamiento", () => {
  it("seis consumos seguidos producen un solo aviso, y el resto queda explicado", async () => {
    const membershipId = await seed();
    const merchant = await merchantId();
    const { sender, sent } = recordingSender();

    for (let i = 0; i < 6; i++) {
      await enqueue(db, {
        membershipId,
        merchantId: merchant,
        kind: "balance_changed",
        now: NOCHE,
      });
    }

    const registered = await statuses(membershipId);
    expect(registered).toHaveLength(6);
    // Ninguno se pierde en silencio: cinco quedan marcados como agrupados.
    expect(registered.filter((n) => n.suppressed_reason === "coalesced")).toHaveLength(5);

    // La ventana de agrupamiento son 15 minutos: antes de eso no sale nada.
    expect(await dispatchDue(db, sender, { now: NOCHE })).toMatchObject({ sent: 0 });

    const despues = new Date(NOCHE.getTime() + 16 * 60 * 1000);
    expect(await dispatchDue(db, sender, { now: despues })).toMatchObject({ sent: 1 });
    expect(sent).toHaveLength(1);
  });

  it("el texto refleja el saldo final, no el de la primera compra", async () => {
    const membershipId = await seed({ coalesceMinutes: 0 });
    const { sender, sent } = recordingSender();

    // Tres consumos en la misma noche. El aviso se encoló con el primero.
    for (const [i, monto] of [50_000, 30_000, 20_000].entries()) {
      await call("POST", "/v1/events", {
        merchant: "r-1",
        idempotencyKey: `order-${i}`,
        type: "order.paid",
        amount: monto,
        membership: { id: membershipId },
      });
    }

    await dispatchDue(db, sender, { now: new Date(Date.now() + 60_000) });

    // Se arma al despachar, con el saldo vivo: 10 puntos, no los 5 del primero.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toBe("Sumaste 10 puntos. Ya tenés 10.");
    expect(sent[0]?.header).toBe("Don Julio");
  });

  it("dos campañas distintas no se agrupan entre sí", async () => {
    const membershipId = await seed();
    const merchant = await merchantId();

    const a = await enqueue(db, {
      membershipId,
      merchantId: merchant,
      kind: "campaign",
      campaignId: await makeCampaign(merchant, "A"),
      header: "A",
      body: "a",
      now: NOCHE,
    });
    const b = await enqueue(db, {
      membershipId,
      merchantId: merchant,
      kind: "campaign",
      campaignId: await makeCampaign(merchant, "B"),
      header: "B",
      body: "b",
      now: NOCHE,
    });

    expect(a.status).toBe("queued");
    expect(b.status).toBe("queued");
  });
});

describe("presupuesto", () => {
  it("corta al llegar al cupo diario de la plataforma", async () => {
    const membershipId = await seed({ coalesceMinutes: 0 });
    const merchant = await merchantId();
    const { sender, sent } = recordingSender();

    // Cada uno con su propia clave para que no se agrupen entre sí.
    for (let i = 0; i < DAILY_BUDGET + 2; i++) {
      await enqueue(db, {
        membershipId,
        merchantId: merchant,
        kind: "campaign",
        campaignId: await makeCampaign(merchant, `C${i}`),
        header: `C${i}`,
        body: "x",
        now: NOCHE,
      });
    }

    const report = await dispatchDue(db, sender, { now: NOCHE });

    // Las campañas tienen cupo reservado, uno menos que el total.
    expect(report.sent).toBe(CAMPAIGN_BUDGET);
    expect(report.suppressed.budget_exhausted).toBe(DAILY_BUDGET + 2 - CAMPAIGN_BUDGET);
    expect(sent).toHaveLength(CAMPAIGN_BUDGET);
  });

  it("una campaña nunca puede dejar sin cupo a un aviso transaccional", async () => {
    const membershipId = await seed({ coalesceMinutes: 0 });
    const merchant = await merchantId();
    const { sender, sent } = recordingSender();

    // La campaña sale a la mañana y consume todo su cupo.
    for (let i = 0; i < 3; i++) {
      await enqueue(db, {
        membershipId,
        merchantId: merchant,
        kind: "campaign",
        campaignId: await makeCampaign(merchant, `C${i}`),
        header: `C${i}`,
        body: "x",
        now: MEDIODIA,
      });
    }
    await dispatchDue(db, sender, { now: MEDIODIA });
    expect(sent).toHaveLength(CAMPAIGN_BUDGET);

    // A la noche el cliente consume. Su aviso tiene que entrar igual, porque el
    // cupo de campañas es menor que el total justamente para dejarle lugar.
    await enqueue(db, {
      membershipId,
      merchantId: merchant,
      kind: "balance_changed",
      now: new Date(MEDIODIA.getTime() + 6 * 60 * 60 * 1000),
    });

    const luego = new Date(MEDIODIA.getTime() + 7 * 60 * 60 * 1000);
    const report = await dispatchDue(db, sender, { now: luego });

    expect(report.sent).toBe(1);
    expect(sent.at(-1)?.kind).toBe("balance_changed");
  });

  it("prioriza lo transaccional cuando compiten por el último lugar", async () => {
    const membershipId = await seed({ coalesceMinutes: 0 });
    const merchant = await merchantId();
    const { sender, sent } = recordingSender();

    // La campaña se encola primero, el aviso de saldo después.
    await enqueue(db, {
      membershipId,
      merchantId: merchant,
      kind: "campaign",
      campaignId: await makeCampaign(merchant),
      header: "Promo",
      body: "2x1",
      now: NOCHE,
    });
    await enqueue(db, {
      membershipId,
      merchantId: merchant,
      kind: "balance_changed",
      now: NOCHE,
    });

    await dispatchDue(db, sender, { now: NOCHE });

    // Se despacha por prioridad, no por orden de llegada.
    expect(sent[0]?.kind).toBe("balance_changed");
  });

  it("el cupo es una ventana móvil de 24 horas, no un día de calendario", async () => {
    const membershipId = await seed({ coalesceMinutes: 0 });
    const merchant = await merchantId();
    const { sender } = recordingSender();

    for (let i = 0; i < 3; i++) {
      await enqueue(db, {
        membershipId,
        merchantId: merchant,
        kind: "campaign",
        campaignId: await makeCampaign(merchant, `C${i}`),
        header: "C",
        body: "x",
        now: NOCHE,
      });
    }
    await dispatchDue(db, sender, { now: NOCHE });

    await enqueue(db, {
      membershipId,
      merchantId: merchant,
      kind: "campaign",
      campaignId: await makeCampaign(merchant, "D"),
      header: "D",
      body: "x",
      now: NOCHE,
    });

    // Veinticinco horas después la ventana ya se corrió y hay cupo de nuevo.
    const pasadas25h = new Date(NOCHE.getTime() + 25 * 60 * 60 * 1000);
    expect(await dispatchDue(db, sender, { now: pasadas25h })).toMatchObject({ sent: 1 });
  });
});

describe("horario permitido por programa", () => {
  it("un restaurante no escribe a las 11 de la noche: lo corre hasta las 9", async () => {
    const membershipId = await seed({ coalesceMinutes: 0, quietHours: { from: 22, to: 9 } });
    const merchant = await merchantId();
    const { sender, sent } = recordingSender();

    await enqueue(db, { membershipId, merchantId: merchant, kind: "balance_changed", now: NOCHE });

    // Se difiere al encolar, no se descarta: el aviso sigue siendo útil más
    // tarde y perderlo por haber caído a la hora equivocada sería peor.
    const pending = await rows<{ scheduled_for: string }>(
      db.drizzle,
      sql`SELECT scheduled_for FROM notification WHERE membership_id = ${membershipId}
          AND sent_at IS NULL AND suppressed_reason IS NULL`,
    );
    expect(pending).toHaveLength(1);
    expect(zonedParts(new Date(pending[0]!.scheduled_for), "America/Asuncion").hour).toBe(9);

    // A las 23:00 no sale nada.
    expect(await dispatchDue(db, sender, { now: NOCHE })).toMatchObject({ sent: 0 });
    expect(sent).toHaveLength(0);

    // A la mañana siguiente, sí.
    const manana = new Date(NOCHE.getTime() + 11 * 60 * 60 * 1000);
    expect(await dispatchDue(db, sender, { now: manana })).toMatchObject({ sent: 1 });
  });

  it("si el comercio cambia su horario después de encolar, el despacho lo respeta", async () => {
    // El aviso se encoló en un horario permitido, pero el comercio después
    // extendió su franja de silencio. La comprobación al despachar es la que
    // evita mandarlo igual.
    const membershipId = await seed({ coalesceMinutes: 0 });
    const merchant = await merchantId();
    const { sender, sent } = recordingSender();

    await enqueue(db, { membershipId, merchantId: merchant, kind: "balance_changed", now: NOCHE });

    await rows(
      db.drizzle,
      sql`UPDATE program
          SET config = jsonb_set(config, '{notifications,quietHours}', '{"from":22,"to":9}')
          WHERE merchant_id = ${merchant} AND status = 'active'`,
    );

    expect(await dispatchDue(db, sender, { now: NOCHE })).toMatchObject({ rescheduled: 1 });
    expect(sent).toHaveLength(0);
  });

  it("un boliche sí escribe a esa hora, porque su silencio es al revés", async () => {
    // Para Noctu la madrugada es el horario útil y el mediodía el inútil. Con una
    // política fija en vez de configurable, uno de los dos verticales queda roto.
    const membershipId = await seed({ coalesceMinutes: 0, quietHours: { from: 6, to: 18 } });
    const merchant = await merchantId();
    const { sender, sent } = recordingSender();

    await enqueue(db, { membershipId, merchantId: merchant, kind: "balance_changed", now: NOCHE });

    expect(await dispatchDue(db, sender, { now: NOCHE })).toMatchObject({ sent: 1 });
    expect(sent).toHaveLength(1);
  });

  it("el mismo boliche se calla al mediodía y espera a las 18", async () => {
    const membershipId = await seed({ coalesceMinutes: 0, quietHours: { from: 6, to: 18 } });
    const merchant = await merchantId();
    const { sender, sent } = recordingSender();

    await enqueue(db, {
      membershipId,
      merchantId: merchant,
      kind: "balance_changed",
      now: MEDIODIA,
    });

    const pending = await rows<{ scheduled_for: string }>(
      db.drizzle,
      sql`SELECT scheduled_for FROM notification WHERE membership_id = ${membershipId}
          AND sent_at IS NULL AND suppressed_reason IS NULL`,
    );
    expect(zonedParts(new Date(pending[0]!.scheduled_for), "America/Asuncion").hour).toBe(18);

    expect(await dispatchDue(db, sender, { now: MEDIODIA })).toMatchObject({ sent: 0 });
    expect(sent).toHaveLength(0);
  });
});

describe("baja y avisos apagados", () => {
  it("no encola nada para quien se dio de baja del canal", async () => {
    const membershipId = await seed();
    const merchant = await merchantId();

    await rows(
      db.drizzle,
      sql`UPDATE membership SET notification_optout = ARRAY['wallet']
          WHERE id = ${membershipId}`,
    );

    const result = await enqueue(db, {
      membershipId,
      merchantId: merchant,
      kind: "balance_changed",
      now: NOCHE,
    });
    expect(result).toEqual({ status: "skipped", reason: "opted_out" });
  });

  it("respeta los avisos automáticos que el comercio apagó", async () => {
    const membershipId = await seed({ disabledKinds: ["tier_changed"] });
    const merchant = await merchantId();

    expect(
      await enqueue(db, { membershipId, merchantId: merchant, kind: "tier_changed", now: NOCHE }),
    ).toEqual({ status: "skipped", reason: "kind_disabled" });

    // Pero no silencia las campañas, que el comercio manda a mano.
    expect(
      (
        await enqueue(db, {
          membershipId,
          merchantId: merchant,
          kind: "campaign",
          campaignId: await makeCampaign(merchant),
          header: "Promo",
          body: "x",
          now: NOCHE,
        })
      ).status,
    ).toBe("queued");
  });
});

describe("campañas", () => {
  it("reporta entrega parcial en vez de un 'enviado' plano", async () => {
    const membershipId = await seed({ coalesceMinutes: 0 });
    const merchant = await merchantId();
    const { sender } = recordingSender();

    // Ana ya recibió avisos hoy y se quedó sin cupo de campañas.
    for (let i = 0; i < CAMPAIGN_BUDGET; i++) {
      await enqueue(db, {
        membershipId,
        merchantId: merchant,
        kind: "campaign",
        campaignId: await makeCampaign(merchant, `C${i}`),
        header: "C",
        body: "x",
        now: NOCHE,
      });
    }
    await dispatchDue(db, sender, { now: NOCHE });

    const campaign = await call("POST", "/v1/campaigns", {
      merchant: "r-1",
      header: "2x1 en tragos",
      body: "Hasta las 12",
      createdBy: "staff:1",
    });
    expect(campaign.statusCode, campaign.body).toBe(201);

    await dispatchDue(db, sender, { now: NOCHE });

    const report = await campaignReport(db, campaign.json().id);
    expect(report.targeted).toBe(1);
    expect(report.delivered).toBe(0);
    // El comercio ve por qué no llegó, no un número inflado.
    expect(report.suppressed.budget_exhausted).toBe(1);
  });

  it("anticipa el alcance real antes de mandar", async () => {
    const membershipId = await seed({ coalesceMinutes: 0 });
    const merchant = await merchantId();
    const { sender } = recordingSender();

    // Sin pase instalado no hay dónde entregar el aviso, así que no cuenta como
    // alcanzable: el canal ES la tarjeta en la billetera.
    const sinPase = await call("GET", "/v1/campaigns/reach?merchant=r-1");
    expect(sinPase.json()).toEqual({ total: 1, reachable: 0, unreachable: 1 });

    await rows(
      db.drizzle,
      sql`INSERT INTO pass_instance (membership_id, merchant_id, platform, external_id,
                                     state, last_synced_balance)
          VALUES (${membershipId}, ${merchant}, 'google', 'obj-alcance', 'active', 0)`,
    );

    const antes = await call("GET", "/v1/campaigns/reach?merchant=r-1");
    expect(antes.json()).toEqual({ total: 1, reachable: 1, unreachable: 0 });

    for (let i = 0; i < CAMPAIGN_BUDGET; i++) {
      await enqueue(db, {
        membershipId,
        merchantId: merchant,
        kind: "campaign",
        campaignId: await makeCampaign(merchant, `C${i}`),
        header: "C",
        body: "x",
        now: new Date(),
      });
    }
    await dispatchDue(db, sender, { now: new Date() });

    const despues = await call("GET", "/v1/campaigns/reach?merchant=r-1");
    expect(despues.json()).toEqual({ total: 1, reachable: 0, unreachable: 1 });
  });

  it("no deja pedir el reporte de una campaña de otro comercio", async () => {
    await seed();
    const campaign = await call("POST", "/v1/campaigns", {
      merchant: "r-1",
      header: "Promo",
      body: "x",
      createdBy: "staff:1",
    });

    await call("POST", "/v1/merchants", {
      externalId: "r-2",
      slug: "la-cabrera",
      legalName: "La Cabrera SA",
      displayName: "La Cabrera",
    });

    const ajeno = await call(
      "GET",
      `/v1/campaigns/${campaign.json().id}/report?merchant=r-2`,
    );
    expect(ajeno.statusCode).toBe(404);
  });
});

describe("fallas de envío", () => {
  it("registra el error sin reintentar en bucle", async () => {
    const membershipId = await seed({ coalesceMinutes: 0 });
    const merchant = await merchantId();

    const roto: NotificationSender = {
      async send() {
        throw new Error("canal caído");
      },
    };

    await enqueue(db, { membershipId, merchantId: merchant, kind: "balance_changed", now: NOCHE });
    expect(await dispatchDue(db, roto, { now: NOCHE })).toMatchObject({ failed: 1 });

    const stored = await rows<{ suppressed_reason: string; last_error: string }>(
      db.drizzle,
      sql`SELECT suppressed_reason, last_error FROM notification
          WHERE membership_id = ${membershipId}`,
    );
    expect(stored[0]?.suppressed_reason).toBe("send_failed");
    expect(stored[0]?.last_error).toContain("canal caído");

    // No queda pendiente: un canal caído no puede convertirse en un bucle que
    // gaste el cupo del cliente reintentando.
    const { sender } = recordingSender();
    expect(await dispatchDue(db, sender, { now: NOCHE })).toMatchObject({ sent: 0 });
  });
});
