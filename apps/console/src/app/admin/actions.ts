"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { adminPut, clearSession, openSession, storeSession } from "../../lib/admin";

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

/**
 * Carga el certificado de Pass Type ID de un comercio.
 *
 * El PEM viaja por un server action y no por el navegador: la clave privada
 * llega al servidor de Next y de ahí a la API, sin pasar por ningún endpoint
 * público ni quedar en el historial de red del operador.
 */
export async function cargarCertificado(
  _prev: { error?: string; ok?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string; ok?: string }> {
  const campo = (k: string) => String(formData.get(k) ?? "").trim();

  const merchantId = campo("merchantId");
  if (!merchantId) return { error: "Elegí un comercio." };

  const certificatePem = campo("certificatePem");
  const privateKeyPem = campo("privateKeyPem");

  // Se avisa acá para no gastar un viaje a la API con algo que claramente no es
  // un PEM — el error del servidor sería el mismo, pero más tarde y más opaco.
  if (!certificatePem.includes("BEGIN CERTIFICATE")) {
    return { error: "Eso no parece un certificado PEM. ¿Convertiste el .cer con openssl?" };
  }
  if (!privateKeyPem.includes("PRIVATE KEY")) {
    return { error: "Eso no parece una clave privada PEM." };
  }

  const guardado = await adminPut<{ expiresAt: string }>(
    `/admin/merchants/${encodeURIComponent(merchantId)}/pass-certificate`,
    { passTypeIdentifier: campo("passTypeIdentifier"), certificatePem, privateKeyPem },
  );

  if (!guardado) {
    return {
      error:
        "No se pudo guardar. El motivo más común es que el certificado no corresponda a esa clave privada.",
    };
  }

  revalidatePath("/admin/dashboard");
  return { ok: new Date(guardado.expiresAt).toLocaleDateString("es-PY") };
}
