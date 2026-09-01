/**
 * Cliente de la App Store Connect API, para provisionar Pass Type IDs.
 *
 * Existe por una cuenta simple: **hay un Pass Type ID y un certificado por
 * comercio**, porque iOS agrupa las tarjetas por ese identificador. Con veinte
 * comercios eso es veinte pasos manuales en el portal de Apple, más veinte
 * renovaciones al año siguiente. Automatizarlo convierte el alta de un comercio
 * en una llamada.
 *
 * La autenticación es un JWT ES256 firmado con la clave `.p8` del equipo. Esa
 * clave **no está acotada a los pases**: con rol Admin puede tocar toda la
 * cuenta de desarrollador. Vive en el gestor de secretos, nunca en el repo.
 */

import { importPKCS8, SignJWT } from "jose";

const BASE = "https://api.appstoreconnect.apple.com/v1";

/**
 * Apple rechaza tokens con más de 20 minutos de vigencia. Se usan 15 para dejar
 * margen si el reloj del servidor va adelantado — un token que Apple considera
 * emitido en el futuro se rechaza igual que uno vencido.
 */
const TOKEN_TTL = "15m";

export interface AscConfig {
  /** 10 caracteres, de la fila de la clave en App Store Connect. */
  keyId: string;
  /** UUID del equipo. El mismo para todas sus claves. */
  issuerId: string;
  /** Contenido del archivo `.p8`, en PEM PKCS#8. */
  privateKeyPem: string;
}

export class AscError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Detalle que devuelve Apple. Suele ser lo único que explica el rechazo. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "AscError";
  }
}

export interface PassTypeIdResource {
  /** Id interno de Apple, no el identificador `pass.com...`. */
  id: string;
  identifier: string;
  name: string;
}

export interface AscClient {
  listPassTypeIds(): Promise<PassTypeIdResource[]>;
  findPassTypeId(identifier: string): Promise<PassTypeIdResource | null>;
  createPassTypeId(identifier: string, name: string): Promise<PassTypeIdResource>;
  /** Devuelve el certificado en PEM, listo para firmar pases. */
  createCertificate(passTypeIdResourceId: string, csrPem: string): Promise<string>;
  listCertificates(): Promise<CertificateResource[]>;
  /**
   * Revoca un certificado. **Irreversible.**
   *
   * **Ojo: Apple no deja revocar todos.** Probado el 2026-09-01 contra un
   * certificado de Pass Type ID creado desde el portal, responde 403 con
   * "This certificate can only be revoked by Apple Developer Program Support",
   * y la página de ese certificado en el portal tampoco ofrece revocarlo — solo
   * descargarlo. Queda como única salida abrir un caso con soporte de Apple.
   *
   * Sin verificar: si un certificado creado **por esta misma API** sí se puede
   * revocar. El mensaje de error lo sugiere pero no lo dice, y comprobarlo
   * implicaba revocar el certificado bueno que estaba en uso.
   */
  revokeCertificate(certificateId: string): Promise<void>;
}

export interface CertificateResource {
  id: string;
  name: string;
  serialNumber: string;
  expiresAt: Date;
}

export function createAscClient(config: AscConfig, fetchImpl: typeof fetch = fetch): AscClient {
  let cached: { token: string; expiresAt: number } | null = null;

  async function token(): Promise<string> {
    // Se reusa mientras le quede más de un minuto: firmar en cada request no
    // cuesta mucho, pero tampoco hace falta.
    if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;

    const key = await importPKCS8(config.privateKeyPem, "ES256");
    const value = await new SignJWT({ aud: "appstoreconnect-v1" })
      .setProtectedHeader({ alg: "ES256", kid: config.keyId, typ: "JWT" })
      .setIssuer(config.issuerId)
      .setIssuedAt()
      .setExpirationTime(TOKEN_TTL)
      .sign(key);

    cached = { token: value, expiresAt: Date.now() + 15 * 60_000 };
    return value;
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetchImpl(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await token()}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      // Apple devuelve los motivos en `errors[].detail`, y ese texto es lo único
      // que distingue "el identificador ya existe" de "no tenés permiso". Tragarlo
      // dejaría un 409 indistinguible de un 403.
      const payload = (await response.json().catch(() => null)) as
        | { errors?: { title?: string; detail?: string }[] }
        | null;
      const primero = payload?.errors?.[0];

      throw new AscError(
        primero?.title ?? `App Store Connect respondió ${response.status}.`,
        response.status,
        primero?.detail,
      );
    }

    // Un DELETE exitoso responde 204 sin cuerpo, y pedirle JSON revienta.
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  interface Envelope<T> {
    data: T;
  }
  interface PassTypeIdData {
    id: string;
    attributes: { identifier: string; name: string };
  }

  const asResource = (d: PassTypeIdData): PassTypeIdResource => ({
    id: d.id,
    identifier: d.attributes.identifier,
    name: d.attributes.name,
  });

  return {
    async listPassTypeIds() {
      const body = await request<Envelope<PassTypeIdData[]>>("GET", "/passTypeIds?limit=200");
      return body.data.map(asResource);
    },

    async findPassTypeId(identifier) {
      const todos = await this.listPassTypeIds();
      return todos.find((p) => p.identifier === identifier) ?? null;
    },

    async createPassTypeId(identifier, name) {
      const body = await request<Envelope<PassTypeIdData>>("POST", "/passTypeIds", {
        data: { type: "passTypeIds", attributes: { identifier, name } },
      });
      return asResource(body.data);
    },

    async createCertificate(passTypeIdResourceId, csrPem) {
      const body = await request<
        Envelope<{ id: string; attributes: { certificateContent: string } }>
      >("POST", "/certificates", {
        data: {
          type: "certificates",
          attributes: { certificateType: "PASS_TYPE_ID", csrContent: csrPem },
          relationships: {
            passTypeId: { data: { type: "passTypeIds", id: passTypeIdResourceId } },
          },
        },
      });

      // Apple devuelve el certificado en DER codificado en base64; los pases se
      // firman con PEM. La conversión va acá para que nadie tenga que recordarla.
      return derToPem(body.data.attributes.certificateContent);
    },

    async listCertificates() {
      const body = await request<
        Envelope<
          {
            id: string;
            attributes: { name: string; serialNumber: string; expirationDate: string };
          }[]
        >
      >("GET", "/certificates?filter[certificateType]=PASS_TYPE_ID&limit=200");

      return body.data.map((c) => ({
        id: c.id,
        name: c.attributes.name,
        serialNumber: c.attributes.serialNumber,
        expiresAt: new Date(c.attributes.expirationDate),
      }));
    },

    async revokeCertificate(certificateId) {
      await request<void>("DELETE", `/certificates/${encodeURIComponent(certificateId)}`);
    },
  };
}

/** DER en base64 a PEM, con las líneas de 64 caracteres que exige el formato. */
export function derToPem(base64Der: string): string {
  const limpio = base64Der.replace(/\s+/g, "");
  const lineas = limpio.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lineas.join("\n")}\n-----END CERTIFICATE-----\n`;
}
