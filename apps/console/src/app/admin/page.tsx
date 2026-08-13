"use client";

import { useActionState } from "react";

import { login } from "./actions";

export default function AdminLogin() {
  const [state, action, pending] = useActionState(login, {});

  return (
    <main className="shell narrow">
      <header className="top">
        <h1>Sophos Loyalty</h1>
        <span className="who">Back-office</span>
      </header>

      <form action={action} className="panel login">
        <p className="hint">
          Esta sesión ve los datos de todos los productos y comercios del
          ecosistema.
        </p>

        <label>
          Tu nombre
          <input name="operator" autoComplete="off" placeholder="diego" required />
        </label>

        <label>
          Clave maestra
          <input name="key" type="password" autoComplete="off" required />
        </label>

        {state?.error ? <p className="error">{state.error}</p> : null}

        <button type="submit" disabled={pending}>
          {pending ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </main>
  );
}
