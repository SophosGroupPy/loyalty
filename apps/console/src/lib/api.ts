/**
 * Cliente de la API de loyalty para la consola, **solo del lado del servidor**.
 *
 * El token de sesión llega por la URL del iframe y se usa acá, en el servidor.
 * El navegador nunca habla directo con la API: eso evita CORS, no expone el host
 * y deja un solo lugar donde revisar cómo se usa la credencial.
 */

const API_URL = process.env.LOYALTY_API_URL ?? "http://127.0.0.1:4001";

export interface Summary {
  merchant: { displayName: string; slug: string };
  cards: number;
  active_cards: number;
  new_this_week: number;
  redemptions: number;
  outstanding: number;
}

export interface ProgramView {
  kind: "points" | "stamps";
  config: {
    earn?: {
      on: string;
      points?: number;
      stamps?: number;
      rate?: { per: number; points: number };
      multiplier?: number;
      minTotal?: number;
      when?: { weekday?: string[]; hour?: number[] };
    }[];
    tiers?: { name: string; min: number }[];
    caps?: { perDay?: number; perEvent?: number };
    rewardAt?: number;
    expiry?: { months: number };
  };
}

export interface EnrollmentLink {
  url: string;
  slug: string;
  displayName: string;
}

async function get<T>(path: string, token: string): Promise<T | null> {
  const response = await fetch(`${API_URL}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    // Los números de la consola tienen que ser los de ahora, no los de hace un
    // minuto: el comercio la abre justamente para ver qué pasó recién.
    cache: "no-store",
  });

  if (!response.ok) return null;
  return response.json() as Promise<T>;
}

export interface AutomaticKind {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
}

export interface NotificationSettings {
  kinds: AutomaticKind[];
  quietHours: { from: number; to: number } | null;
  dailyBudget: number;
  campaignBudget: number;
}

export interface Reach {
  total: number;
  reachable: number;
  unreachable: number;
}

export interface CampaignRow {
  id: string;
  header: string;
  body: string;
  created_at: string;
  targeted: number;
  delivered: number;
  pending: number;
  suppressed: number;
}

export interface LocationRow {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  relevant_text: string | null;
  created_at: string;
}

export const fetchLocations = (token: string) =>
  get<{ locations: LocationRow[]; max: number }>("/embed/locations", token);

export async function del(path: string, token: string): Promise<boolean> {
  const response = await fetch(`${API_URL}${path}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  return response.ok;
}

export interface CustomerRow {
  id: string;
  serial_number: string;
  display_name: string | null;
  phone: string;
  balance: number;
  tier: string | null;
  issued_at: string;
  visits: number;
  total_spent: number;
  avg_ticket: number | null;
  last_visit: string | null;
  redemptions: number;
}

export const fetchCustomers = (token: string, sort = "recent", q = "") =>
  get<{ customers: CustomerRow[] }>(
    `/embed/customers?sort=${sort}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
    token,
  );

export interface CardDesignView {
  programName: string;
  logoUrl: string;
  backgroundColor: string;
  balanceLabel: string;
  newsLabel: string;
  foregroundColor: string;
  labelColor: string;
  logoText: string;
  heroImageUrl: string;
  stripImageUrl: string;
}

export const fetchDesign = (token: string) =>
  get<{ design: CardDesignView; merchantName: string; unit: "points" | "stamps" }>(
    "/embed/design",
    token,
  );

export interface RewardRow {
  id: string;
  name: string;
  cost: number;
  terms: string | null;
  status: "active" | "archived";
  redemptions: number;
  /** Cuántos clientes activos ya tienen saldo para canjearlo. */
  can_afford: number;
}

export const fetchRewards = (token: string) =>
  get<{ rewards: RewardRow[]; members: number }>("/embed/rewards", token);

export const fetchSummary = (token: string) => get<Summary>("/embed/summary", token);
export const fetchNotifications = (token: string) =>
  get<NotificationSettings>("/embed/notifications", token);
export const fetchReach = (token: string) => get<Reach>("/embed/campaigns/reach", token);
export const fetchCampaigns = (token: string) =>
  get<{ campaigns: CampaignRow[] }>("/embed/campaigns", token);

/** Escribe en la API con el token de la sesión de consola. */
export async function post<T>(path: string, token: string, body: unknown): Promise<T | null> {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  return response.ok ? ((await response.json()) as T) : null;
}

export async function put<T>(path: string, token: string, body: unknown): Promise<T | null> {
  const response = await fetch(`${API_URL}${path}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  return response.ok ? ((await response.json()) as T) : null;
}
export const fetchProgram = (token: string) => get<ProgramView>("/embed/program", token);
export const fetchEnrollmentLink = (token: string) =>
  get<EnrollmentLink>("/embed/enrollment-link", token);
