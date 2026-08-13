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
| Service account de GCP | ✅ `loyalty-issuer@loyalty-sophos.iam.gserviceaccount.com` |
| Invitada en Wallet Console | ✅ rol **Developer** |
| Publishing access | ⏳ **solicitado el 2026-08-12** |

**Sobre el publishing access:** Google responde por mail en 2-3 días hábiles. Si
no llega nada para el **2026-08-17**, escalar por *Contact support* en la
consola. Es irreversible: una vez aprobado no se puede volver a demo mode.

> ⚠️ **Antes de que llegue la aprobación, archivar o borrar la clase
> `don-julio`.** La consola avisa que *"any classes you have set to Active will
> immediately be published when access is granted"*, y esa es una clase de
> prueba de un restaurante ficticio, con el logo de Sophos como placeholder.
> Si queda activa, se publica como si fuera un comercio real.

## Lo ya verificado contra la API real (2026-08-12)

Emisión completa de una tarjeta de prueba, guardada en la cuenta
`sophosgroup.py@gmail.com` en demo mode:

- ✅ **La marca visible es la del comercio.** La tarjeta dice "Don Julio", no
  Sophos. La atribución del mandato aparece en el dorso: *"Emitido por Sophos
  Group EAS en nombre de Don Julio SA."*
- ✅ **El saldo se actualiza sin reinstalar el pase.** Se guardó con 8 puntos, se
  hizo `PATCH` a 777 y la tarjeta lo reflejó. Es el criterio que definía si toda
  la capa servía: sin esto, cada acumulación exigiría reemitir.
- ✅ **Las clases se aprueban solas.** La primera volvió con `reviewStatus:
  approved` sin intervención, pese a haberse enviado como `UNDER_REVIEW`.
  **Dar de alta un comercio nuevo es instantáneo**, no hay cola de revisión por
  comercio. Conviene reconfirmarlo tras el publishing access, por si el
  comportamiento cambia fuera de demo mode.
- ✅ El QR lleva el serial y coincide con el Member ID.

Herramientas que quedaron para repetir esto:

```bash
pnpm check:google              # diagnostica credenciales y lista clases
pnpm demo                      # flujo completo, termina en el save link
pnpm patch:balance <serial> N  # empuja un saldo a un pase ya emitido
```

### `notifyPreference` — resuelto

**La referencia REST de Google estaba equivocada.** Decía *"When set to NOTIFY,
we will attempt to trigger a field update notification"*, pero la API rechaza ese
valor:

```
Invalid value at 'resource.notify_preference'
(type.googleapis.com/google.walletobjects.v1.NotificationSettingsForUpdates), "NOTIFY"
```

El valor correcto es **`NOTIFY_ON_UPDATE`**, el que indicaban las páginas de
casos de uso. Ya está corregido en `enums.ts` — fue un cambio de una línea
porque el valor estaba aislado ahí justamente previendo esto.

### Geocercas — el pase las recibe

Con la tarjeta instalada, Google Wallet ofrece *"Get notified when you're near
[TEST ONLY] Don Julio"*. O sea que **`merchantLocations` llega bien** y el
sistema operativo la reconoce, pese al cambio anunciado en I/O 2026.

## Lo que sigue sin verificar

- ⬜ **Que la notificación push efectivamente llegue.** La API acepta
  `NOTIFY_ON_UPDATE` y el saldo se actualiza, pero **no se observó la
  notificación en el emulador**. Puede ser una limitación del emulador —la
  entrega vía Play Services ahí es poco confiable— o cuestión de tiempo.
  **Requiere un Android real para descartarlo.**
- ⬜ **Que la geocerca dispare al acercarse.** El pase la tiene registrada, pero
  probar que salta exige estar físicamente cerca del local.
- ⬜ **El tope de 3 notificaciones cada 24 h.**

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

## Cómo probar sin un Android a mano

**Google Wallet no tiene app en iOS.** En un iPhone solo entran pases `.pkpass`,
o sea Apple Wallet, que está bloqueado por el enrollment. Así que un iPhone no
sirve para probar nada de esto.

Hay tres caminos, en orden de conveniencia:

### 1. Navegador de escritorio — cubre casi todo, sin instalar nada

Abrí el `saveUrl` en Chrome logueado con una cuenta de prueba. Google guarda el
pase en esa cuenta. Verifica lo que más riesgo tiene:

- Que el JWT esté bien firmado y Google lo acepte
- Que la clase exista y el objeto sea válido
- Que la tarjeta muestre **el comercio** y no Sophos
- Que el saldo, el QR y la atribución del dorso salgan bien

### 2. Emulador de Android — para las notificaciones

Ya está instalado en la Mac del equipo:

```bash
export JAVA_HOME="/opt/homebrew/opt/openjdk"
export ANDROID_HOME="/opt/homebrew/share/android-commandlinetools"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$JAVA_HOME/bin:$PATH"
emulator -avd wallet-test
```

Hace falta una imagen **con Play Store** (`google_apis_playstore`) para poder
instalar Google Wallet. **Puede que Wallet se niegue a correr en un emulador**:
verifica integridad del dispositivo, y aunque para pases suele ser más permisivo
que para tap-to-pay, no está garantizado.

### 3. Un Android real — para la geocerca

Es el único camino para verificar que la tarjeta aparezca en la pantalla
bloqueada al acercarse al local. No hay forma de simularlo con fidelidad.

> **Ojo con esto:** ni Diego ni Federico usan Android, así que el equipo no va a
> poder dogfoodear su propio producto hasta la fase 4. Es fácil descuidar lo que
> no usás todos los días — vale la pena agendar pruebas explícitas en vez de
> confiar en el uso cotidiano.

## Un pendiente nuevo: geocercas

En Google I/O 2026 se anunció *"removal of geofence location caps via Google
Maps"*. El manejo de `merchantLocations` puede haber cambiado respecto de lo que
está implementado. **Revisar antes de apoyarse en las geocercas**, que según el
diseño son el canal de notificación más barato del sistema porque no consumen
cupo diario.

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
