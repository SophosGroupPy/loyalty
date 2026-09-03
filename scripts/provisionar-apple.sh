#!/usr/bin/env bash
#
# Da de alta el material de firma de Apple de un comercio.
#
# Sin esto el comercio puede emitir en Google Wallet pero no en iPhone: el
# certificado de Pass Type ID es **por comercio**, no del ecosistema.
#
#   ./scripts/provisionar-apple.sh              # lista quién tiene y quién no
#   ./scripts/provisionar-apple.sh <merchantId> # da de alta a ese comercio
#
# La clave maestra la busca sola en Fly si no está en el entorno. El valor no se
# imprime nunca.
#
# OJO: crear un Pass Type ID es permanente. Queda para siempre en la cuenta de
# Apple de Sophos, no se puede borrar por API, y el slug del comercio queda
# adentro del identificador. Un comercio de prueba quema un identificador real.

set -euo pipefail

API="${LOYALTY_API:-https://tarjeta.sophosgroup.com.py}"
APP="${FLY_APP:-sophos-loyalty}"

# ---------------------------------------------------------------------------
# La clave maestra
#
# `fly ssh console -C` no es una fuente limpia: imprime "Connecting to ..."
# junto con la salida del comando. Capturar eso a ciegas daba una clave con el
# banner pegado adelante, y un 401 que parecía "la clave está mal" cuando en
# realidad estaba mal *leída*.
#
# Se toma la última línea no vacía y se valida antes de mandarla. Una clave con
# espacios o con el banner adentro se rechaza acá, con un mensaje que dice qué
# pasó, en vez de viajar al servidor y volver como "no autorizado".
# ---------------------------------------------------------------------------
CLAVE="${ADMIN_API_KEY:-}"
ORIGEN="la variable ADMIN_API_KEY"

if [ -z "$CLAVE" ]; then
  echo "Leyendo la clave maestra desde Fly ($APP)..." >&2
  CLAVE=$(
    fly ssh console --app "$APP" -C 'printenv ADMIN_API_KEY' 2>/dev/null \
      | tr -d '\r' \
      | grep -v '^[[:space:]]*$' \
      | tail -n 1 \
      | tr -d '[:space:]' || true
  )
  ORIGEN="Fly"
fi

if [ -z "$CLAVE" ]; then
  echo "No se pudo leer ADMIN_API_KEY desde $ORIGEN." >&2
  echo "Probá a mano:  fly ssh console --app $APP -C 'printenv ADMIN_API_KEY'" >&2
  exit 1
fi

case "$CLAVE" in
  Connecting*|*" "*)
    echo "Lo que salió de $ORIGEN no es una clave: se coló la salida del propio comando." >&2
    echo "Largo leído: ${#CLAVE} caracteres." >&2
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------

RESPUESTA=$(
  ADMIN_API_KEY="$CLAVE" python3 -c 'import json, os
print(json.dumps({"key": os.environ["ADMIN_API_KEY"], "operator": "provisioning"}))' \
  | curl -sS -X POST "$API/admin/session" -H 'content-type: application/json' --data-binary @-
)

TOKEN=$(printf '%s' "$RESPUESTA" | python3 -c 'import sys, json
try:
    print(json.load(sys.stdin).get("token", ""))
except Exception:
    print("")')

if [ -z "$TOKEN" ]; then
  echo "El back-office rechazó la clave que salió de $ORIGEN (${#CLAVE} caracteres)." >&2
  echo "Contestó: $(printf '%s' "$RESPUESTA" | head -c 200)" >&2
  exit 1
fi

# Sin argumento: mostrar el estado y salir. Provisionar es permanente, así que
# el modo por defecto no toca nada.
#
# Nota para quien edite el Python de abajo: va entre comillas simples de shell,
# así que adentro solo se pueden usar comillas dobles. Y las f-strings de
# Python < 3.12 no admiten barras invertidas en la parte de la expresión, así
# que todo valor se calcula en una variable antes de interpolarlo.
if [ $# -eq 0 ]; then
  curl -sS "$API/admin/pass-certificates" -H "authorization: Bearer $TOKEN" \
  | python3 -c 'import sys, json
cs = json.load(sys.stdin)["certificates"]
if not cs:
    print("No hay comercios dados de alta todavía.")
    raise SystemExit
ancho = max(len(c["merchantName"]) for c in cs)
faltan = 0
for c in cs:
    tiene = c["passTypeIdentifier"]
    nombre = c["merchantName"]
    producto = c["productName"]
    if tiene:
        estado = "OK  " + tiene
    else:
        estado = "SIN CERTIFICADO - no emite en iPhone"
        faltan += 1
    print(f"{nombre:<{ancho}}  {producto:<10}  {estado}")
    if not tiene:
        hueco = " " * ancho
        print(f"{hueco}  -> ./scripts/provisionar-apple.sh " + c["merchantId"])
if faltan:
    print()
    print("Provisionar es permanente: el Pass Type ID queda para siempre en la")
    print("cuenta de Apple de Sophos y lleva el slug del comercio adentro.")'
  exit 0
fi

MERCHANT="$1"
echo "Pidiéndole a Apple un Pass Type ID y un certificado para $MERCHANT..."

curl -sS -X POST "$API/admin/merchants/$MERCHANT/provision-pass" \
  -H "authorization: Bearer $TOKEN" \
| python3 -c 'import sys, json
r = json.load(sys.stdin)
if "error" in r:
    print("Apple rechazó el pedido: " + str(r["error"]))
    if r.get("message"):
        print("  " + str(r["message"]))
    if r.get("detail"):
        print("  " + str(r["detail"]))
    raise SystemExit(1)
identificador = r["passTypeIdentifier"]
estado = "reusado" if r["reused"] else "nuevo"
vence = r["expiresAt"][:10]
print("Listo: " + identificador)
print(f"  Pass Type ID {estado}, vence {vence}")
print("  Las tarjetas nuevas ya salen en iPhone. Las ya emitidas no cambian.")'
