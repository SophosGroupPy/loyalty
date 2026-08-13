/**
 * Raíz sin token: no es una pantalla de producto, es un cartel para el
 * desarrollador que abrió la URL a mano.
 */
export default function Home() {
  return (
    <main className="shell">
      <div className="error-box">
        <p>
          Esta consola se abre desde ElMenu, Noctu o FactuFast, embebida en un
          iframe con un token de sesión.
        </p>
        <p className="hint">
          Para probarla: <code className="url">/embed?token=…</code>
        </p>
      </div>
    </main>
  );
}
