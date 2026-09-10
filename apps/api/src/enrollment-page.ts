/**
 * Landing de alta white-label, servida por la propia API.
 *
 * Es la página que abre el cliente al escanear el QR impreso en la mesa/mostrador
 * (`tarjeta.sophosgroup.com.py/{slug}`). Como el resto de las superficies que mira
 * una persona y no un servidor —ver `paginaDeProblema`—, no lleva marca de Sophos:
 * el cliente conoce al comercio, no a nosotros. La marca del comercio (logo,
 * color, nombre) se inyecta desde el diseño de su tarjeta.
 *
 * Todo va embebido —HTML, CSS y JS en un solo string— a propósito: es una página
 * sin build, y un archivo suelto de assets se desactualiza solo. El flujo usa los
 * endpoints públicos que ya existen: `POST /public/enrollment/start` (manda el
 * código) y `POST /public/enrollment/verify` (crea la tarjeta y devuelve los links
 * de wallet).
 */

export interface EnrollmentBranding {
  slug: string;
  displayName: string;
  programName: string;
  logoUrl: string | null;
  backgroundColor: string;
  unit: "points" | "stamps";
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Escapa texto para meterlo en el HTML sin abrir una inyección. */
function esc(t: string): string {
  return t.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/**
 * Contraste sobre el color de marca: decide si el texto del botón va blanco o
 * negro, con luminancia relativa (el ojo pesa el verde mucho más que el azul).
 */
function textoSobre(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#ffffff";
  const v = parseInt(m[1]!, 16);
  const [r, g, b] = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.6 ? "#ffffff" : "#111111";
}

export function enrollmentPage(b: EnrollmentBranding): string {
  const marca = HEX.test(b.backgroundColor) ? b.backgroundColor : "#1F2937";
  const sobreMarca = textoSobre(marca);
  const unidad = b.unit === "stamps" ? "sellos" : "puntos";

  // La marca se inyecta como JSON seguro para el JS; el `<` escapado evita que un
  // valor con `</script>` corte el bloque.
  const datos = JSON.stringify({ slug: b.slug, displayName: b.displayName }).replace(
    /</g,
    "\\u003c",
  );

  const logo = b.logoUrl
    ? `<img class="logo" src="${esc(b.logoUrl)}" alt="" onerror="this.style.display='none'">`
    : `<div class="logo logo--ph" aria-hidden="true"></div>`;

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${esc(b.programName)}</title>
<style>
  :root { --marca: ${marca}; --sobre: ${sobreMarca}; }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #111827; background: #f3f4f6;
    min-height: 100dvh; display: flex; align-items: center; justify-content: center;
    padding: 20px;
  }
  .card {
    width: 100%; max-width: 400px; background: #fff; border-radius: 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,.08), 0 12px 32px rgba(0,0,0,.08);
    overflow: hidden;
  }
  .top {
    background: var(--marca); color: var(--sobre); padding: 28px 24px 24px;
    text-align: center;
  }
  .logo { width: 64px; height: 64px; border-radius: 16px; object-fit: contain;
    background: rgba(255,255,255,.14); }
  .logo--ph { }
  .top h1 { margin: 14px 0 2px; font-size: 20px; font-weight: 700; }
  .top p { margin: 0; font-size: 14px; opacity: .82; }
  .body { padding: 22px 24px 26px; }
  .step { display: none; }
  .step.on { display: block; animation: fade .25s ease; }
  @keyframes fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  label { display: block; font-size: 13px; font-weight: 600; color: #374151; margin: 0 0 6px; }
  input[type=tel], input[type=text] {
    width: 100%; padding: 13px 14px; font-size: 16px; border: 1.5px solid #e5e7eb;
    border-radius: 12px; outline: none; -webkit-appearance: none;
  }
  input:focus { border-color: var(--marca); }
  .field { margin-bottom: 14px; }
  .hint { font-size: 12.5px; color: #6b7280; margin: 6px 2px 0; }
  .btn {
    width: 100%; padding: 14px; font-size: 16px; font-weight: 600; border: none;
    border-radius: 12px; background: var(--marca); color: var(--sobre); cursor: pointer;
    display: flex; align-items: center; justify-content: center; gap: 8px;
  }
  .btn[disabled] { opacity: .55; cursor: default; }
  .btn.sec { background: #fff; color: #111827; border: 1.5px solid #e5e7eb; }
  .err { color: #b91c1c; font-size: 13.5px; margin: 12px 2px 0; min-height: 1px; }
  .consent { display: flex; gap: 10px; align-items: flex-start; margin: 12px 0; }
  .consent input { margin-top: 3px; width: 18px; height: 18px; accent-color: var(--marca); flex: none; }
  .consent span { font-size: 13px; color: #4b5563; }
  .link { background: none; border: none; color: var(--marca); font-size: 13.5px;
    font-weight: 600; cursor: pointer; padding: 8px 0 0; }
  .spin { width: 16px; height: 16px; border: 2px solid currentColor; border-right-color: transparent;
    border-radius: 50%; animation: r .7s linear infinite; }
  @keyframes r { to { transform: rotate(360deg); } }
  .done-ico { width: 56px; height: 56px; border-radius: 50%; background: #ecfdf5; color: #059669;
    display: grid; place-items: center; margin: 0 auto 12px; font-size: 30px; }
  .wallets { display: flex; flex-direction: column; gap: 10px; margin-top: 18px; }
  .wallet { display: flex; align-items: center; justify-content: center; gap: 10px;
    padding: 14px; border-radius: 12px; text-decoration: none; font-weight: 600; font-size: 15px; }
  .w-apple { background: #000; color: #fff; }
  .w-google { background: #fff; color: #111827; border: 1.5px solid #dadce0; }
  .foot { text-align: center; font-size: 12px; color: #9ca3af; padding: 4px 24px 18px; }
</style>
</head>
<body>
  <div class="card">
    <div class="top">
      ${logo}
      <h1>${esc(b.programName)}</h1>
      <p>Sumá ${esc(unidad)} en ${esc(b.displayName)}</p>
    </div>
    <div class="body">
      <!-- Paso 1: celular -->
      <section class="step on" id="s1">
        <div class="field">
          <label for="phone">Tu celular</label>
          <input id="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="0981 123 456">
          <p class="hint">Te mandamos un código para confirmarlo. Es tu llave de la tarjeta.</p>
        </div>
        <button class="btn" id="b-start">Continuar</button>
        <p class="err" id="e1"></p>
      </section>

      <!-- Paso 2: código + nombre + consentimiento -->
      <section class="step" id="s2">
        <div class="field">
          <label for="code">Código</label>
          <input id="code" type="tel" inputmode="numeric" autocomplete="one-time-code" placeholder="000000">
          <p class="hint">Enviado a <b id="echo"></b>. <button class="link" id="b-resend" type="button">Reenviar</button></p>
        </div>
        <div class="field">
          <label for="name">Tu nombre <span style="font-weight:400;color:#9ca3af">(opcional)</span></label>
          <input id="name" type="text" autocomplete="name" placeholder="Nombre y apellido">
        </div>
        <label class="consent">
          <input type="checkbox" id="c-prog">
          <span>Acepto sumarme al programa de ${esc(b.displayName)} y que use mis datos para gestionarlo.</span>
        </label>
        <label class="consent">
          <input type="checkbox" id="c-id">
          <span>Acepto que Sophos Group conserve mi celular verificado para no volver a pedírmelo si me sumo a otro comercio. <span style="color:#9ca3af">(opcional)</span></span>
        </label>
        <button class="btn" id="b-verify">Confirmar</button>
        <p class="err" id="e2"></p>
      </section>

      <!-- Paso 3: listo + wallets -->
      <section class="step" id="s3">
        <div class="done-ico">&#10003;</div>
        <h2 style="text-align:center;margin:0 0 4px;font-size:19px">¡Ya estás adentro!</h2>
        <p style="text-align:center;margin:0;color:#6b7280;font-size:14px">Agregá tu tarjeta para tenerla siempre a mano.</p>
        <div class="wallets" id="wallets"></div>
        <p class="hint" style="text-align:center" id="s3-note"></p>
      </section>
    </div>
    <div class="foot">Programa de fidelidad de ${esc(b.displayName)}</div>
  </div>

<script>
(function () {
  var M = ${datos};
  var $ = function (id) { return document.getElementById(id); };
  var phone = "";

  function step(n) {
    ["s1","s2","s3"].forEach(function (id, i) { $(id).classList.toggle("on", i === n - 1); });
  }
  function err(id, msg) { $(id).textContent = msg || ""; }
  function loading(btn, on, label) {
    btn.disabled = on;
    btn.innerHTML = on ? '<span class="spin"></span>' : label;
  }
  async function post(path, body) {
    var r = await fetch(path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    var data = {};
    try { data = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, data: data };
  }

  $("b-start").onclick = async function () {
    err("e1", "");
    var p = $("phone").value.trim();
    if (p.replace(/\\D/g, "").length < 6) { return err("e1", "Poné un celular válido."); }
    loading($("b-start"), true, "Continuar");
    var res = await post("/public/enrollment/start", { merchant: M.slug, phone: p });
    loading($("b-start"), false, "Continuar");
    if (!res.ok) {
      if (res.status === 400) return err("e1", "Ese número no parece válido.");
      if (res.status === 429) return err("e1", "Muchos intentos. Probá en unos minutos.");
      if (res.status === 404) return err("e1", "Este programa no está disponible.");
      return err("e1", "No pudimos enviar el código. Probá de nuevo.");
    }
    phone = p;
    $("echo").textContent = p;
    step(2);
    $("code").focus();
  };

  $("b-resend").onclick = async function () {
    err("e2", "");
    var res = await post("/public/enrollment/start", { merchant: M.slug, phone: phone });
    err("e2", res.ok ? "Te enviamos un código nuevo." : "No pudimos reenviar. Probá en unos minutos.");
  };

  $("b-verify").onclick = async function () {
    err("e2", "");
    var code = $("code").value.trim();
    if (code.length < 4) return err("e2", "Ingresá el código que te llegó.");
    if (!$("c-prog").checked) return err("e2", "Necesitás aceptar sumarte al programa.");
    var ids = ["programa/v1"];
    if ($("c-id").checked) ids.push("identidad/v1");
    var name = $("name").value.trim();
    loading($("b-verify"), true, "Confirmar");
    var res = await post("/public/enrollment/verify", {
      merchant: M.slug, phone: phone, code: code,
      displayName: name || undefined,
      acceptsProgram: true,
      acceptsSharedIdentity: $("c-id").checked,
      consentIds: ids,
    });
    loading($("b-verify"), false, "Confirmar");
    if (!res.ok) {
      if (res.status === 401) return err("e2", "El código no es correcto.");
      if (res.status === 410) return err("e2", "El código venció. Pedí uno nuevo.");
      return err("e2", "No pudimos confirmar. Probá de nuevo.");
    }
    success(res.data);
  };

  function success(data) {
    step(3);
    var w = $("wallets");
    var apple = data.appleUrl, google = data.saveUrl;
    var iOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    var items = [];
    if (apple) items.push('<a class="wallet w-apple" href="' + apple + '">&#63743; Agregar a Apple Wallet</a>');
    if (google) items.push('<a class="wallet w-google" href="' + google + '">Agregar a Google Wallet</a>');
    // En iPhone, Apple primero; en el resto, Google primero.
    if (!iOS) items.reverse();
    w.innerHTML = items.join("");
    $("s3-note").textContent = items.length
      ? "Se abre en tu billetera. Si ya la tenías, quedó actualizada."
      : "Tu tarjeta ya está activa con tu número. Pedí en el local que te ayuden a agregarla.";
  }
})();
</script>
</body>
</html>`;
}
