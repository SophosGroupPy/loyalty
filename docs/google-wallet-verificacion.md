# Verificación de Google Wallet contra un Issuer real

Toda la capa de pases está construida y testeada, pero **hay valores que la
documentación de Google define de forma contradictoria y que no se pueden dirimir
sin un Issuer**. Equivocarse en ellos no produce un error: la notificación
simplemente no llega, que es la peor forma de fallar porque nadie se entera.

Este documento es la lista de lo que hay que confirmar el día que exista el
Issuer. Todos los valores en duda viven en un solo archivo:
[`packages/passes/src/google/enums.ts`](../packages/passes/src/google/enums.ts).

## Antes de empezar

1. Crear el Issuer en la [Google Wallet Business Console](https://pay.google.com/business/console).
   Es gratis y no depende del trámite de Apple.
2. Crear una service account en GCP con el rol de Wallet Object Issuer y
   descargar la clave JSON.
3. Autorizar la service account en la consola de Wallet (Users → Invite).
4. Configurar el entorno:

```bash
export GOOGLE_WALLET_ISSUER_ID="3388000000012345678"
export GOOGLE_WALLET_SA_EMAIL="loyalty@tu-proyecto.iam.gserviceaccount.com"
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
