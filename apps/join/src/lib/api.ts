/**
 * Cliente de la API de loyalty, **solo para el servidor**.
 *
 * La landing nunca llama a la API desde el navegador: todo pasa por route
 * handlers de Next. Así el host de la API no queda expuesto, no hace falta CORS,
 * y el día que estos endpoints necesiten una credencial no hay que rehacer el
 * flujo — se agrega acá y el cliente ni se entera.
 */

const API_URL = process.env.LOYALTY_API_URL ?? "http://127.0.0.1:3001";

export interface MerchantBranding {
  slug: string;
  displayName: string;
  programName: string;
  logoUrl: string | null;
  backgroundColor: string;
  unit: "points" | "stamps";
}

export async function fetchBranding(slug: string): Promise<MerchantBranding | null> {
  const response = await fetch(`${API_URL}/public/merchants/${encodeURIComponent(slug)}`, {
    // El diseño del comercio cambia rara vez, pero no queremos que un cambio
    // tarde horas en verse. Un minuto es buen equilibrio.
    next: { revalidate: 60 },
  });

  if (!response.ok) return null;
  return response.json() as Promise<MerchantBranding>;
}

/** Reenvía una llamada del navegador a la API, preservando el código de estado. */
export async function proxy(path: string, body: unknown): Promise<Response> {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return new Response(await response.text(), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
}
