"use client";

import { useActionState } from "react";

import type { CertificateRow } from "../../lib/admin";
import { cargarCertificado, provisionar } from "./actions";

/** Días que quedan, o `null` si no hay certificado. */
function diasHasta(fecha: string | null): number | null {
  if (!fecha) return null;
  return Math.floor((new Date(fecha).getTime() - Date.now()) / 86_400_000);
}

function Estado({ fila }: { fila: CertificateRow }) {
  const dias = diasHasta(fila.expiresAt);

  if (dias === null) return <span className="warn">Sin certificado</span>;
  if (dias < 0) return <span className="bad">Vencido</span>;
  // 45 días alcanzan para pedirle el certificado nuevo a Apple sin apuro.
  if (dias < 45) return <span className="warn">Vence en {dias} días</span>;
  return <span className="cond">{dias} días</span>;
}

export function Certificados({ filas }: { filas: CertificateRow[] }) {
  const [state, action, pending] = useActionState(cargarCertificado, {});
  const [alta, accionAlta, altaPendiente] = useActionState(provisionar, {});

  const sinCertificado = filas.filter((f) => !f.passTypeIdentifier);

  return (
    <>
      <p className="cond">
        Cada comercio tiene su propio Pass Type ID y su propio certificado, así
        que en la Wallet del cliente <strong>sus tarjetas quedan separadas</strong>:
        la de un restaurante no se apila con la de un bar. Es la razón de que
        haya un certificado por comercio y no uno solo para todos — iOS agrupa
        las tarjetas por Pass Type ID, y el campo que serviría para separarlas
        (<code>groupingIdentifier</code>) no aplica a las tarjetas de fidelidad.
      </p>
      <p className="cond">
        Los certificados <strong>vencen al año</strong>. Un comercio con el
        certificado vencido deja de poder actualizar las tarjetas ya emitidas:
        el saldo se congela y el cliente no se entera.
      </p>

      {sinCertificado.length > 0 ? (
        <p className="aviso-inline">
          {sinCertificado.length}{" "}
          {sinCertificado.length === 1 ? "comercio no puede" : "comercios no pueden"} emitir en
          iPhone todavía. En Android funcionan igual.
        </p>
      ) : null}

      <div className="panel">
      <table>
        <thead>
          <tr>
            <th>Comercio</th>
            <th>Producto</th>
            <th>Pass Type ID</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          {filas.map((fila) => (
            <tr key={fila.merchantId}>
              <td>{fila.merchantName}</td>
              <td className="cond">{fila.productName}</td>
              <td className="cond">{fila.passTypeIdentifier ?? `pass.com.sophosgroup.l.${fila.slug}`}</td>
              <td>
                <Estado fila={fila} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <h3 style={{ marginTop: "2rem" }}>Dar de alta automáticamente</h3>
      <p className="cond">
        Registra el Pass Type ID en Apple, genera la clave y el certificado, y
        los guarda cifrados — todo sin entrar al portal. La clave privada se
        genera en el servidor y nunca pasa por el navegador. Sirve igual para
        renovar: el identificador se reusa y solo se pide un certificado nuevo.
      </p>

      <form action={accionAlta} className="composer">
        <label>
          Comercio
          <select name="merchantId" required defaultValue="">
            <option value="" disabled>
              Elegí un comercio
            </option>
            {filas.map((fila) => (
              <option key={fila.merchantId} value={fila.merchantId}>
                {fila.merchantName} · {fila.productName}
                {fila.passTypeIdentifier ? " (renovar)" : ""}
              </option>
            ))}
          </select>
        </label>

        {alta?.error ? <p className="error">{alta.error}</p> : null}
        {alta?.ok ? <p className="ok">{alta.ok}</p> : null}

        <button type="submit" disabled={altaPendiente}>
          {altaPendiente ? "Hablando con Apple…" : "Dar de alta en Apple"}
        </button>
      </form>

      <h3 style={{ marginTop: "2rem" }}>Cargar un certificado a mano</h3>
      <p className="cond">
        Para el caso en que el certificado ya exista fuera del sistema. Lo normal
        es usar el alta automática de arriba.
      </p>
      <form action={action} className="composer">
        <label>
          Comercio
          <select name="merchantId" required defaultValue="">
            <option value="" disabled>
              Elegí un comercio
            </option>
            {filas.map((fila) => (
              <option key={fila.merchantId} value={fila.merchantId}>
                {fila.merchantName} · {fila.productName}
                {fila.passTypeIdentifier ? " (renovar)" : ""}
              </option>
            ))}
          </select>
        </label>

        <label>
          Pass Type ID
          <input
            name="passTypeIdentifier"
            placeholder="pass.com.sophosgroup.l.don-julio"
            required
          />
        </label>

        <label>
          Certificado (PEM)
          <textarea
            name="certificatePem"
            rows={4}
            placeholder="-----BEGIN CERTIFICATE-----"
            required
          />
        </label>

        <label>
          Clave privada (PEM)
          <textarea
            name="privateKeyPem"
            rows={4}
            placeholder="-----BEGIN RSA PRIVATE KEY-----"
            required
          />
        </label>

        {state?.error ? <p className="error">{state.error}</p> : null}
        {state?.ok ? <p className="ok">Certificado guardado. Vence el {state.ok}.</p> : null}

        <button type="submit" disabled={pending}>
          {pending ? "Guardando…" : "Guardar certificado"}
        </button>
      </form>
    </>
  );
}
