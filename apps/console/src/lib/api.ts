/**
 * Cliente de la API de loyalty para la consola, **solo del lado del servidor**.
 *
 * El token de sesión llega por la URL del iframe y se usa acá, en el servidor.
 * El navegador nunca habla directo con la API: eso evita CORS, no expone el host
 * y deja un solo lugar donde revisar cómo se usa la credencial.
 */

const API_URL = process.env.LOYALTY_API_URL ?? "http://127.0.0.1:3001";

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

export const fetchSummary = (token: string) => get<Summary>("/embed/summary", token);
export const fetchProgram = (token: string) => get<ProgramView>("/embed/program", token);
export const fetchEnrollmentLink = (token: string) =>
  get<EnrollmentLink>("/embed/enrollment-link", token);
