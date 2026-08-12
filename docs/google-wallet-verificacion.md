# Verificación de Google Wallet contra un Issuer real

Toda la capa de pases está construida y testeada, pero **hay valores que la
documentación de Google define de forma contradictoria y que no se pueden dirimir
sin un Issuer**. Equivocarse en ellos no produce un error: la notificación
simplemente no llega, que es la peor forma de fallar porque nadie se entera.

Este documento es la lista de lo que hay que confirmar el día que exista el
Issuer. Todos los valores en duda viven en un solo archivo:
[`packages/passes/src/google/enums.ts`](../packages/passes/src/google/enums.ts).

## Estado del trámite

| | |
|---|---|
| Cuenta en Google Pay & Wallet Console | ✅ creada como **Sophos Group** |
| Merchant ID (Google Pay) | `BCR2DN6D3KFLZNRV` — **no** es el Issuer, no sirve acá |
| **Issuer ID (Google Wallet)** | ✅ **`3388000000023171859`** |
| Service account de GCP | ⬜ pendiente |
| Publishing access | ⬜ **pendiente, y es el que tarda** |

> **La cuenta arranca en demo mode.** Las tarjetas solo las pueden guardar cuentas
> de Google que estén en la lista de prueba. Para clientes reales hay que pedir
> **publishing access**, que Google revisa manualmente. Conviene pedirlo cuanto
> antes: es tiempo de calendario que corre en paralelo al desarrollo, igual que
> se hizo con Google frente a Apple.
>
> Demo mode alcanza para todo lo de esta checklist.

## Antes de empezar

1. Crear una service account en GCP con el rol de Wallet Object Issuer y
   descargar la clave JSON.
2. **Invitarla en Wallet Console → Users.** Es el paso que más se olvida: sin
   esta invitación la API responde 403 y el error no menciona que falta.
3. Agregar tu cuenta de Google a la lista de prueba, para poder guardar la
   primera tarjeta en tu propio teléfono.
4. Configurar el entorno (o copiar `.env.example` a `.env.local`):

```bash
export GOOGLE_WALLET_ISSUER_ID="3388000000023171859"
export GOOGLE_WALLET_SA_EMAIL="$(jq -r .client_email clave.json)"
export GOOGLE_WALLET_SA_PRIVATE_KEY="$(jq -r .private_key clave.json)"
export GOOGLE_WALLET_ORIGINS="https://tarjeta.sophosgroup.com.py"
```

> El `private_key` del JSON viene con `\n` escapados. El código los desescapa
> solo, pero si lo pegás a mano en un panel de variables asegurate de no perder
> los saltos de línea.

## Lo que hay que verificar

### 1. `notifyPreference` — el más importante

**El conflicto:** la referencia REST de `loyaltyclass` dice *"When set to NOTIFY,
we will attempt to trigger a field update notification"*. La página de casos de
uso de loyalty cards dice `notifyPreference: notifyOnUpdate`.

Está implementado con `NOTIFY`. Constante: `NOTIFY_PREFERENCE_ON_UPDATE`.

**Cómo verificar:**
1. Emitir una tarjeta y guardarla en un Android real con notificaciones de
   Wallet habilitadas.
2. Acumular puntos vía `POST /v1/events`.
3. ¿Llegó la notificación al teléfono?
   - **Sí** → el valor es correcto, no tocar nada.
   - **No** → cambiar la constante a `NOTIFY_PREFERENCE_FALLBACK`
     (`NOTIFY_ON_UPDATE`, ya definida en el mismo archivo) y repetir.

Si la API hubiese rechazado el valor, el error aparece en
`pass_instance.last_error`. Que no haya error y tampoco notificación es
exactamente el escenario que este paso busca descartar.

### 2. `reviewStatus`

Implementado como `UNDER_REVIEW`; la referencia lista `draft | underReview | approved`.

**Cómo verificar:** crear la primera clase. Si la API la rechaza, probar
`underReview`. Una clase en `draft` no admite objetos, así que ese valor no sirve.

### 3. `merchantLocations` y las geo-notificaciones

`locations` quedó deprecado y Google documenta que **ya no dispara
geo-notificaciones**. Está implementado con `merchantLocations`.

**Cómo verificar:** cargar la ubicación real de un local, guardar la tarjeta en
un teléfono y acercarse físicamente. Tiene que aparecer en la pantalla
bloqueada. El radio lo fija Google y no se puede configurar — a diferencia de
Apple, donde `maxDistance` se elige por pase.

Es el canal de notificación más barato del sistema porque no consume el cupo
diario, así que vale la pena confirmar que funciona antes de apoyarse en él.

### 4. El tope de 3 notificaciones cada 24 h

Documentado por Google, no verificado. Está replicado del lado de Sophos en
`NOTIFICATIONS_PER_PASS_PER_DAY` porque **el Issuer es único para todo el
ecosistema**: si un comercio abusa, el throttling cae sobre todos los comercios
a la vez.

**Cómo verificar:** disparar 5 acumulaciones sobre la misma tarjeta en un día y
contar cuántas notificaciones llegan.

## Prueba de humo completa

```bash
pnpm dev
```

```bash
curl -s -X POST localhost:3001/oauth/token -H 'content-type: application/json' \
  -d '{"grant_type":"client_credentials","client_id":"...","client_secret":"..."}'
```

Después: crear comercio → programa → diseño → tarjeta → `POST /v1/passes`.
El `saveUrl` que devuelve se abre en un Android y tiene que agregar la tarjeta.

Comprobar que la tarjeta muestra **el nombre del comercio y no Sophos**, y que
en el dorso aparece "Emitido por Sophos Group EAS en nombre de {razón social}",
que es lo que exige el mandato con el que se firman los pases.
