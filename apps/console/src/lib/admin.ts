/**
 * Cliente del back-office, **solo servidor**.
 *
 * A diferencia de la consola embebida —donde el token viaja en la URL del
 * iframe porque no hay alternativa—, acá controlamos las dos puntas: el token va
 * en una cookie httpOnly y nunca toca el JavaScript del navegador. Este panel ve
 * todo el ecosistema, así que no puede quedar en el historial ni en un log de
 * proxy.
 */

import { cookies } from "next/headers";

const API_URL = process.env.LOYALTY_API_URL ?? "http://127.0.0.1:4001";
const COOKIE = "sophos_admin";

export interface ProductRow {
  id: string;
  slug: string;
  name: string;
  merchants: number;
  active_programs: number;
  cards: number;
  outstanding: number;
}

export interface IdentityGraph {
  people: number;
  multi: number;
  cross_product: number;
}

export interface Health {
  passes: { drifted: number; errored: number };
  webhooks: { pending: number; exhausted: number };
  notifications: { pending: number; suppressed: number };
}

export interface MerchantRow {
  id: string;
  external_id: string;
  slug: string;
  display_name: string;
  legal_name: string;
  product: string;
  program_kind: "points" | "stamps" | null;
  cards: number;
  outstanding: number;
  last_card_at: string | null;
}

/** Canjea la clave maestra por una sesión. Devuelve el token o un motivo. */
export async function openSession(
  key: string,
  operator: string,
): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  const response = await fetch(`${API_URL}/admin/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, operator }),
    cache: "no-store",
  });

  if (response.status === 503) {
    return { ok: false, reason: "El back-office no está habilitado: falta ADMIN_API_KEY." };
  }
  if (!response.ok) {
    return { ok: false, reason: "Clave incorrecta." };
  }

  const body = (await response.json()) as { token: string };
  return { ok: true, token: body.token };
}

export async function storeSession(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    // En desarrollo se sirve por HTTP; en producción la cookie no puede viajar
    // en claro.
    secure: process.env.NODE_ENV === "production",
    path: "/admin",
    maxAge: 8 * 60 * 60,
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

async function get<T>(path: string): Promise<T | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;

  const response = await fetch(`${API_URL}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    // El back-office existe para ver qué pasa AHORA; un dato cacheado sería
    // peor que no mostrarlo.
    cache: "no-store",
  });

  if (!response.ok) return null;
  return response.json() as Promise<T>;
}

export const fetchOverview = () =>
  get<{ products: ProductRow[]; identityGraph: IdentityGraph | null }>("/admin/overview");

export const fetchHealth = () => get<Health>("/admin/health");

export const fetchMerchants = () => get<{ merchants: MerchantRow[] }>("/admin/merchants");

export interface CertificateRow {
  merchantId: string;
  merchantName: string;
  slug: string;
  productName: string;
  /** `null` cuando ese comercio todavía no puede emitir en iPhone. */
  passTypeIdentifier: string | null;
  expiresAt: string | null;
}

export const fetchCertificates = () =>
  get<{ certificates: CertificateRow[] }>("/admin/pass-certificates");

/** Escribe en el back-office con la sesión guardada en la cookie. */
export async function adminPut<T>(path: string, body: unknown): Promise<T | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;

  const response = await fetch(`${API_URL}${path}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  return response.ok ? ((await response.json()) as T) : null;
}

/** POST al back-office con la sesión guardada en la cookie. */
export async function adminPost<T>(path: string): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return { ok: false, message: "Sesión vencida." };

  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const body = (await response.json().catch(() => null)) as
    | { message?: string; detail?: string }
    | null;

  if (!response.ok) {
    // El detalle que devuelve Apple suele ser lo único que explica el rechazo;
    // mostrar solo "falló" dejaría al operador sin nada.
    return {
      ok: false,
      message: [body?.message, body?.detail].filter(Boolean).join(" ") || "No se pudo completar.",
    };
  }
  return { ok: true, data: body as T };
}
