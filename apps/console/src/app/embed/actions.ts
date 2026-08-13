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
