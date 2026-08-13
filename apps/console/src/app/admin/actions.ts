"use server";

import { redirect } from "next/navigation";

import { clearSession, openSession, storeSession } from "../../lib/admin";

/**
 * Login del back-office.
 *
 * Es una server action a propósito: la clave maestra viaja del formulario al
 * servidor y no pasa nunca por el JavaScript del navegador. Con un fetch desde
 * el cliente quedaría en memoria del renderer y en las herramientas de red.
 */
export async function login(
  _prev: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  const key = String(formData.get("key") ?? "");
  const operator = String(formData.get("operator") ?? "").trim();

  if (!key || !operator) {
    return { error: "Completá tu nombre y la clave." };
  }

  const session = await openSession(key, operator);
  if (!session.ok) return { error: session.reason };

  await storeSession(session.token);
  redirect("/admin/dashboard");
}

export async function logout(): Promise<void> {
  await clearSession();
  redirect("/admin");
}
