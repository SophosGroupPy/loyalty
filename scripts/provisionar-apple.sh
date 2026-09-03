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
# La clave maestra se lee de ADMIN_API_KEY y nunca se imprime.
#
# OJO: crear un Pass Type ID es permanente. Queda para siempre en la cuenta de
# Apple de Sophos, no se puede borrar por API, y el slug del comercio queda
# adentro del identificador. Un comercio de prueba quema un identificador real.

set -euo pipefail

API="${LOYALTY_API:-https://tarjeta.sophosgroup.com.py}"

if [ -z "${ADMIN_API_KEY:-}" ]; then
  echo "Falta ADMIN_API_KEY. Cargala primero:" >&2
  echo "  export ADMIN_API_KEY=\$(fly ssh console -C 'printenv ADMIN_API_KEY' | tr -d '\\r\\n')" >&2
  exit 1
fi

TOKEN=$(
  curl -sS -X POST "$API/admin/session" \
    -H 'content-type: application/json' \
    --data-binary "$(ADMIN_API_KEY="$ADMIN_API_KEY" python3 -c \
      'import json,os;print(json.dumps({"key":os.environ["ADMIN_API_KEY"],"operator":"provisioning"}))')" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))'
)

if [ -z "$TOKEN" ]; then
  echo "La clave maestra no fue aceptada por $API." >&2
  exit 1
fi

# Sin argumento: mostrar el estado y salir. Provisionar es permanente, así que
# el modo por defecto no toca nada.
if [ $# -eq 0 ]; then
  curl -sS "$API/admin/pass-certificates" -H "authorization: Bearer $TOKEN" \
  | python3 -c '
import sys, json
cs = json.load(sys.stdin)["certificates"]
if not cs:
    print("No hay comercios dados de alta todavía.")
    raise SystemExit
ancho = max(len(c["merchantName"]) for c in cs)
for c in cs:
    tiene = c["passTypeIdentifier"]
    print(f"{c[\"merchantName\"]:<{ancho}}  {c[\"productName\"]:<10}  "
          f"{\"✓ \" + tiene if tiene else \"✗ sin certificado — no emite en iPhone\"}")
    if not tiene:
        print(f"{\"\":<{ancho}}  → ./scripts/provisionar-apple.sh {c[\"merchantId\"]}")
'
  exit 0
fi

MERCHANT="$1"
echo "Pidiéndole a Apple un Pass Type ID y un certificado para $MERCHANT…"

curl -sS -X POST "$API/admin/merchants/$MERCHANT/provision-pass" \
  -H "authorization: Bearer $TOKEN" \
| python3 -c '
import sys, json
r = json.load(sys.stdin)
if "error" in r:
    print(f"Apple rechazó el pedido: {r[\"error\"]}")
    if r.get("message"): print(f"  {r[\"message\"]}")
    if r.get("detail"):  print(f"  {r[\"detail\"]}")
    raise SystemExit(1)
print(f"Listo: {r[\"passTypeIdentifier\"]}")
print(f"  Pass Type ID {\"reusado\" if r[\"reused\"] else \"nuevo\"}, vence {r[\"expiresAt\"][:10]}")
print("  Las tarjetas nuevas ya salen en iPhone. Las ya emitidas no cambian.")
'
