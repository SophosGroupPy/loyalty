"use server";

import { revalidatePath } from "next/cache";

import { post, put } from "../../lib/api";

/**
 * Server actions de la consola.
 *
 * El token viaja en un campo oculto del formulario. Es el mismo que ya está en
 * la URL del iframe, así que no expone nada nuevo — y mantiene la escritura del
 * lado del servidor, sin que el navegador hable directo con la API.
 */

export async function enviarCampana(
  _prev: { error?: string; ok?: boolean } | undefined,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const token = String(formData.get("token") ?? "");
  const header = String(formData.get("header") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();

  if (!token) return { error: "Sesión vencida. Volvé a abrir el módulo." };
  if (!header || !body) return { error: "Completá el título y el mensaje." };

  const created = await post<{ id: string }>("/embed/campaigns", token, { header, body });
  if (!created) return { error: "No se pudo enviar. Probá de nuevo." };

  revalidatePath("/embed");
  return { ok: true };
}

export async function guardarDiseno(
  _prev: { error?: string; ok?: boolean } | undefined,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const token = String(formData.get("token") ?? "");
  if (!token) return { error: "Sesión vencida. Volvé a abrir el módulo." };

  const campo = (k: string) => String(formData.get(k) ?? "").trim();

  const saved = await put("/embed/design", token, {
    programName: campo("programName"),
    logoUrl: campo("logoUrl"),
    backgroundColor: campo("backgroundColor"),
    balanceLabel: campo("balanceLabel"),
    newsLabel: campo("newsLabel"),
    foregroundColor: campo("foregroundColor"),
    labelColor: campo("labelColor"),
    logoText: campo("logoText"),
    heroImageUrl: campo("heroImageUrl"),
    stripImageUrl: campo("stripImageUrl"),
  });

  if (!saved) {
    return { error: "No se pudo guardar. Revisá que el logo sea una URL válida." };
  }

  revalidatePath("/embed");
  return { ok: true };
}

export async function crearBeneficio(
  _prev: { error?: string; ok?: boolean } | undefined,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const token = String(formData.get("token") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const cost = Number(formData.get("cost"));
  const terms = String(formData.get("terms") ?? "").trim();

  if (!token) return { error: "Sesión vencida. Volvé a abrir el módulo." };
  if (!name) return { error: "Poné un nombre al beneficio." };
  if (!Number.isInteger(cost) || cost <= 0) {
    return { error: "El costo tiene que ser un número mayor a cero." };
  }

  const created = await post<{ id: string }>("/embed/rewards", token, {
    name,
    cost,
    ...(terms ? { terms } : {}),
  });

  if (!created) {
    return { error: "No se pudo crear. Revisá que tengas un programa configurado." };
  }

  revalidatePath("/embed");
  return { ok: true };
}

export async function cambiarEstadoBeneficio(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!token || !id) return;

  await put(`/embed/rewards/${encodeURIComponent(id)}`, token, { status });
  revalidatePath("/embed");
}

export async function guardarAvisos(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  if (!token) return;

  // Los que NO vienen tildados son los que el comercio apagó.
  const todos = formData.getAll("kind").map(String);
  const activos = new Set(formData.getAll("enabled").map(String));
  const disabledKinds = todos.filter((k) => !activos.has(k));

  await put("/embed/notifications", token, { disabledKinds });
  revalidatePath("/embed");
}
