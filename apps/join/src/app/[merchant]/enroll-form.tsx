"use client";

import { useState } from "react";

/**
 * Alta en tres pasos: celular → código → tarjeta.
 *
 * Dos decisiones que no son cosméticas:
 *
 * - **Los consentimientos son dos casillas separadas y ninguna viene marcada.**
 *   Son dos bases legales distintas bajo la Ley 7593/2025: una consiente el
 *   programa del comercio, la otra que Sophos conserve la identidad verificada.
 *   Preseleccionarlas, o juntarlas en una sola, invalidaría el consentimiento.
 * - **Solo la primera es obligatoria.** Se puede tener la tarjeta del comercio
 *   sin aceptar el registro compartido; lo único que se pierde es que el
 *   próximo alta del ecosistema sea de un toque.
 */

type Step = "phone" | "code" | "done";

interface Props {
  slug: string;
  merchantName: string;
  accent: string;
}

interface Result {
  serialNumber: string;
  saveUrl: string | null;
  personExisted: boolean;
}

export function EnrollForm({ slug, merchantName, accent }: Props) {
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [acceptsProgram, setAcceptsProgram] = useState(false);
  const [acceptsSharedIdentity, setAcceptsSharedIdentity] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function start(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const response = await fetch("/api/enrollment/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchant: slug, phone }),
    });

    setBusy(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(
        body.error === "invalid_phone"
          ? "Revisá el número, no parece un celular válido."
          : body.error === "rate_limited"
            ? "Pediste varios códigos seguidos. Esperá un rato e intentá de nuevo."
            : "No pudimos enviarte el código. Probá de nuevo en un momento.",
      );
      return;
    }

    setStep("code");
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const response = await fetch("/api/enrollment/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchant: slug,
        phone,
        code,
        ...(name.trim() ? { displayName: name.trim() } : {}),
        acceptsProgram,
        acceptsSharedIdentity,
      }),
    });

    setBusy(false);
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      setError(
        body.error === "invalid_code"
          ? `Código incorrecto. Te quedan ${body.attemptsLeft} intentos.`
          : body.error === "expired"
            ? "El código venció. Pedí uno nuevo."
            : body.error === "too_many_attempts"
              ? "Demasiados intentos. Pedí un código nuevo."
              : "No pudimos verificar el código. Probá de nuevo.",
      );
      return;
    }

    setResult(body as Result);
    setStep("done");
  }

  if (step === "done" && result) {
    return (
      <div>
        <h2 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>
          ¡Listo{name.trim() ? `, ${name.trim().split(" ")[0]}` : ""}!
        </h2>
        <p className="hint">
          Ya sos parte del programa de {merchantName}.
          {result.personExisted ? " Reconocimos tu número, así que fue directo." : ""}
        </p>

        {result.saveUrl ? (
          <a className="wallet-link" href={result.saveUrl}>
            Agregar a Google Wallet
          </a>
        ) : (
          <p className="hint">
            Mostrá este código en el local para sumar puntos:{" "}
            <strong>{result.serialNumber}</strong>
          </p>
        )}
      </div>
    );
  }

  if (step === "code") {
    return (
      <form onSubmit={verify}>
        <p className="hint">
          Te mandamos un código de 6 dígitos al {phone}.
        </p>

        <label htmlFor="code">Código</label>
        <input
          id="code"
          className="code-input"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          required
          autoFocus
        />

        {/* Los consentimientos van acá, junto al acto de confirmar: aceptar en
            una pantalla y confirmar en otra distancia el consentimiento de la
            acción que consiente. */}
        <label className="consent">
          <input
            type="checkbox"
            checked={acceptsProgram}
            onChange={(e) => setAcceptsProgram(e.target.checked)}
          />
          <span>
            Acepto participar del programa de fidelidad de {merchantName} y que
            guarde mis datos de contacto y consumo.
          </span>
        </label>

        <label className="consent">
          <input
            type="checkbox"
            checked={acceptsSharedIdentity}
            onChange={(e) => setAcceptsSharedIdentity(e.target.checked)}
          />
          <span>
            Acepto que Sophos Group conserve mi celular verificado para no tener
            que validarlo de nuevo en otros comercios. <em>Opcional.</em>
          </span>
        </label>

        {error ? <p className="error">{error}</p> : null}

        <button
          type="submit"
          style={{ background: accent }}
          disabled={busy || code.length < 6 || !acceptsProgram}
        >
          {busy ? "Verificando…" : "Obtener mi tarjeta"}
        </button>

        <button
          type="button"
          className="link-button"
          onClick={() => {
            setStep("phone");
            setCode("");
            setError(null);
          }}
        >
          Cambiar el número
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={start}>
      <label htmlFor="phone">Tu celular</label>
      <input
        id="phone"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        placeholder="0993 427654"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        required
        autoFocus
      />

      <label htmlFor="name">Tu nombre</label>
      <input
        id="name"
        type="text"
        autoComplete="given-name"
        placeholder="Ana"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />

      {error ? <p className="error">{error}</p> : null}

      <button type="submit" style={{ background: accent }} disabled={busy || !phone.trim()}>
        {busy ? "Enviando…" : "Enviarme el código"}
      </button>
    </form>
  );
}
