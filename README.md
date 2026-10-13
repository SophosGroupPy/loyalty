# Sophos Loyalty

Módulo de fidelidad con tarjetas en wallet para el ecosistema Sophos Group
(ElMenu, Noctu, FactuFast).

No es un programa de fidelidad global: **cada comercio tiene su propio programa y
emite su propia tarjeta**, con su propio saldo. Lo único compartido entre
comercios es el registro de la persona, identificado por celular verificado, y
solo sirve para que el segundo alta del ecosistema sea de un toque.

Plan completo de arquitectura: `~/.claude/plans/estamos-desarrollando-un-programa-silly-mccarthy.md`

## Estado

| Fase | Alcance | Estado |
|---|---|---|
| 1 | Motor, ledger, API, aislamiento multi-tenant, aviso al POS | ✅ |
| 2 | Google Wallet: emisión, sincronización, geocercas, diseño | ✅ en producción |
| 2 | Despachador de notificaciones: cupo, prioridad, agrupamiento, campañas | ✅ |
| 2 | Alta con OTP, landing white-label por QR, consola embebible | ✅ |
| 3 | Webhooks salientes firmados y SDK de integración | ✅ |
| 3 | Integración dentro de ElMenu y Noctu | pendiente |
| 4 | Apple Wallet: `.pkpass`, web service, push por APNs, alta automática de certificados | ✅ en producción |
| 4 | NFC (Apple VAS) | en revisión por Apple |

Las dos wallets están en producción en **https://tarjeta.sophosgroup.com.py**
(Fly, región `gru`, base en Neon `sa-east-1`). El cliente escanea el QR del
local, verifica su celular y la landing le ofrece el botón que corresponde a su
teléfono: Google en Android, Apple en iPhone.

**Google Wallet.** Issuer `3388000000023171859`, publishing access aprobado el
2026-08-13 y fuera de demo mode: cualquiera puede guardar una tarjeta, sin el
prefijo `[TEST ONLY]`, y ya se emiten tarjetas reales contra ese Issuer. El
objeto se crea del lado del servidor al emitir, no recién cuando la persona
guarda, y si Google responde 404 al sincronizar o al avisar, se reconstruye y se
reintenta una vez. Los valores que la documentación de Google define de forma
contradictoria, y cuáles se verificaron contra la API real, están en
[docs/google-wallet-verificacion.md](docs/google-wallet-verificacion.md).

**Apple Wallet.** Membresía de organización activa desde el 2026-09-01 (Team
`3W23SYPG6H`). El ciclo completo se verificó el 2026-09-02 contra un iPhone real:
el servidor le pide a Apple el Pass Type ID y el certificado sin que nadie entre
al portal, firma el `.pkpass`, el teléfono lo agrega y se registra, y al cambiar
el saldo el push de APNs lo despierta y vuelve a bajar el pase. Hay **un Pass
Type ID por comercio**, no uno global — con uno compartido, las tarjetas de
todos los comercios se le apilan al cliente en una sola pila. El alta del
certificado la hace sola el scheduler para todo comercio que no lo tenga, así
que activar el módulo alcanza.

El entitlement de NFC se pidió el 2026-09-01 y sigue en revisión. El v1 va con
QR en las dos wallets y no depende de él.

## Estructura

```
packages/rules   motor de reglas declarativo, puro y sin dependencias
packages/db      esquema, migraciones y conexión (PGlite en dev, Postgres en prod)
packages/passes  Google Wallet (builders, save links, cliente REST) y Apple Wallet
                 (pass.json, firma PKCS#7, .pkpass, logos, cliente de App Store Connect)
packages/sdk     SDK para los productos integradores y verificación de webhooks
apps/api         API: OAuth2, ingesta, tarjetas, canjes, pases, web service de
                 Apple, back-office y la landing de alta en /:slug
apps/console     consola del comercio, embebible en el producto con SSO, y back-office de Sophos
apps/join        alta del cliente con OTP (Next)
```

## Comandos

```bash
pnpm install
pnpm test          # 446 casos en 26 archivos
pnpm typecheck
pnpm dev           # levanta la API en :4001
pnpm build         # empaqueta la API a dist/ para producción
```

La consola y el alta corren aparte con `pnpm --filter @sophos/console dev`
(:4003) y `pnpm --filter @sophos/join dev` (:4002), y le hablan a la API por
`LOYALTY_API_URL`.

Sin `DATABASE_URL` la API levanta **PGlite en memoria** — Postgres real compilado
a WASM, sin servidor que instalar — y siembra un comercio de prueba para que la
landing tenga algo que mostrar. Sirve para desarrollo, pero pierde todo al
reiniciar. Con `DATABASE_URL` apunta al Postgres de Neon y corre las mismas
migraciones.

### Variables

| Variable | Obligatoria | Para qué |
|---|---|---|
| `DATABASE_URL` | en producción | Postgres. Sin ella, PGlite en memoria. |
| `JWT_SIGNING_KEY` | en producción | Firma de los access token. Si cambia, todos los productos integrados pierden sus tokens. |
| `PORT` | no | Por defecto 4001. |
| `ADMIN_API_KEY` | para el back-office | Ve todo el ecosistema. Sin ella, `/admin/session` responde 503 y el back-office queda deshabilitado. |
| `JOIN_BASE_URL` | no | Base del link de alta que se imprime en el QR. Por defecto `https://tarjeta.sophosgroup.com.py`. |
| `GOOGLE_WALLET_ISSUER_ID` | para emitir en Google | Issuer de Sophos: `3388000000023171859`. |
| `GOOGLE_WALLET_SA_EMAIL` | para emitir en Google | Service account de GCP. |
| `GOOGLE_WALLET_SA_PRIVATE_KEY` | para emitir en Google | Clave privada PEM. Acepta los `\n` escapados del JSON de GCP. |
| `GOOGLE_WALLET_ORIGINS` | no | Dominios autorizados a mostrar el botón de guardado. |
| `APPLE_TEAM_ID` | para emitir en Apple | `3W23SYPG6H`. Sin esta y la siguiente, se registran dispositivos pero no se emiten pases. |
| `APPLE_WEB_SERVICE_URL` | para emitir en Apple | URL pública del web service; el iPhone le agrega `/v1/devices/...`. |
| `APPLE_PASS_ENCRYPTION_KEY` | para emitir en Apple | 32 bytes en hex o base64. Cifra en reposo las claves privadas de los certificados. Nunca va a la base. |
| `APPLE_WWDR_PEM` | para emitir en Apple | Certificado intermedio de Apple, compartido por todos los comercios. |
| `APPLE_ASC_KEY_ID` | para el alta automática | Clave de la App Store Connect API. Sin las tres `APPLE_ASC_*`, el alta de certificados vuelve a ser manual. |
| `APPLE_ASC_ISSUER_ID` | para el alta automática | |
| `APPLE_ASC_PRIVATE_KEY` | para el alta automática | El `.p8`, que Apple deja descargar una sola vez. Tiene rol Admin sobre toda la cuenta. |

## Las invariantes que no se negocian

Están cubiertas por tests; si alguna se rompe, la suite falla.

1. **El asiento es la verdad, el saldo es una proyección.** `membership.balance`
   solo se escribe en la misma transacción que el asiento que lo justifica, y el
   ledger es append-only — hay un trigger en Postgres que rechaza `UPDATE` y
   `DELETE`. Para revertir algo se inserta un asiento de ajuste. Sin esto no hay
   forma de resolver una disputa con un comercio.

2. **Reprocesar un evento no acumula dos veces.** La unicidad de
   `(product_id, idempotency_key)` hace seguro que un POS con mala señal
   reintente: el segundo intento devuelve el resultado del primero.

3. **El aislamiento pasa siempre por el producto autenticado.** `resolveMerchant`
   es el único punto que traduce una referencia externa a un `merchant_id`, y
   siempre lleva `product_id` en el `WHERE`. Conocer el UUID de un comercio ajeno
   no habilita nada.

4. **Un comercio solo ve sus propios clientes.** Toda consulta de tarjetas está
   acotada a `merchant_id`, incluso entre comercios del mismo producto.

5. **El QR identifica pero no autoriza.** Toda acumulación y todo canje se
   validan server-side contra un evento de venta real, así que no importa que
   alguien comparta una captura de su tarjeta.

6. **Una caída de Google o de Apple no puede romper una acumulación.** El
   cliente ya consumió y sus puntos le corresponden. La sincronización del pase
   y el push de APNs corren fuera de la transacción del asiento, no propagan
   excepciones, y dejan el desfasaje registrado en `pass_instance` para que la
   reconciliación lo levante después (`GET /v1/passes/pending-sync`). Lo mismo
   entre las dos wallets: si una falla al avisar, se intenta igual por la otra.

7. **Ninguna notificación se pierde en silencio.** Cada intento deja una fila:
   la que se manda y también las que se agrupan o se descartan, con el motivo.
   Es lo que permite responderle a un comercio por qué su campaña llegó a 453
   de 500 en vez de mostrarle un "enviado" plano.

8. **Una campaña nunca puede dejar sin aviso a un cliente que consume.** Las
   campañas tienen un cupo menor que el total (`CAMPAIGN_BUDGET`), reservando
   lugar para lo transaccional. La prioridad sola no alcanza: solo ordena lo que
   está pendiente al mismo tiempo, y una notificación ya enviada no se devuelve.

## Decisiones que conviene conocer antes de tocar el código

- **Los multiplicadores de promoción no se acumulan entre sí: se aplica el
  mayor.** "Jueves x2" y "cumpleaños x3" el mismo día dan x3, no x6.
  Multiplicarlos convertiría dos promos razonables en un pasivo que el comercio
  no dimensionó.

  **El del nivel sí se multiplica con ellos.** Un cliente Oro (x2) en el happy
  hour (x2) suma x4. Son dos incentivos distintos —lealtad y franja— y quedarse
  con el mayor le sacaría sentido a tener los dos. El nivel se mide con el saldo
  con el que el cliente llega al consumo, no con el que le queda, y los topes por
  evento y por día se aplican después de multiplicar, así que el nivel nunca los
  rompe. `event.result` guarda `tierMultiplier` aparte, para poder explicar un
  saldo hasta el último punto.

- **El día de negocio no es el día del calendario.** Un bar con
  `dayBoundaryHour: 6` imputa el consumo de la 1 AM del sábado al viernes, que es
  la noche que el cliente y el comercio consideran una sola. Sin esto, el tope
  diario se duplica en cada salida nocturna.

- **Todo se evalúa en el huso del programa**, no en UTC. Un happy hour de jueves
  18–20 en Asunción evaluado en UTC aplicaría en el horario equivocado.

- **Los eventos que no acumulan no ensucian el ledger**, pero dejan su traza en
  `event.result`. Es lo que permite responder "¿por qué este consumo no sumó
  puntos?" sin adivinar.

- **La notificación guarda una intención, no un texto.** El cuerpo se arma al
  despachar, con el saldo vivo, así tres consumos agrupados muestran el total
  final y no el de la primera compra. Las campañas son la excepción, porque el
  texto lo escribió el comercio.

- **Sincronizar el pase y notificar son cosas distintas.** El pase se actualiza
  en silencio tras cada acumulación para que la tarjeta esté al día al instante;
  avisarle al cliente consume un cupo escaso y lo decide el despachador. Si el
  sync notificara solo, una noche movida agotaría el cupo del día.

- **El perfil del cliente vive en `membership`, no en `person`.** Que el bar
  edite el nombre de un cliente no puede tocar su ficha en el restaurante.

- **Un Pass Type ID de Apple por comercio, y no se puede revocar.** Apple no
  deja revocar certificados de Pass Type ID, así que cada alta quema un
  identificador para siempre. Por eso el alta automática tiene tope por tanda y
  espera creciente ante un rechazo, y `BURNED_PASS_TYPE_IDS` en
  `apps/api/src/provisioning.ts` bloquea los que ya quedaron expuestos (el de
  prueba `don-julio`). Al renovar se reusa el identificador y solo se pide un
  certificado nuevo: cambiarlo dejaría huérfanos los pases ya emitidos.

- **El aviso de Apple viaja dentro del pase.** Apple no tiene un "mandar
  mensaje": la novedad se guarda en el pase con `changeMessage` y un push de
  APNs vacío despierta al teléfono para que lo vuelva a bajar. El resultado del
  push queda en `pass_instance.last_error`, que es lo que permite distinguir
  "Apple lo rechazó" de "el teléfono todavía no sincronizó".

## API

Todo es backend a backend. Un access token de loyalty nunca debe llegar al
cliente: quien tenga uno puede leer la base de clientes de un comercio.

```
POST /oauth/token                 client_credentials → access token del producto
POST /v1/merchants                alta/actualización de comercio (idempotente)
PUT  /v1/programs                 crea o reemplaza el programa activo
POST /v1/rewards                  catálogo de beneficios
POST /v1/memberships              alta de tarjeta (idempotente)
GET  /v1/memberships/lookup       identificar cliente en el POS (?phone= | ?serial=)
POST /v1/events                   ingesta de eventos de negocio (idempotente)
POST /v1/events/reverse           deshace la acumulación de un consumo
POST /v1/redemptions              canje de un beneficio
POST /v1/redemptions/reverse      deshace un canje y devuelve los puntos
PUT  /v1/design                   diseño de la tarjeta (logo, colores, etiquetas)
POST /v1/locations                geocercas del comercio (máximo 10)
POST /v1/passes                   emite la tarjeta de Google y devuelve el save link
POST /v1/passes/apple             emite la tarjeta de Apple y devuelve el link de descarga
GET  /v1/passes/pending-sync      pases desfasados: la cola de reconciliación
GET  /v1/campaigns/reach          alcance real antes de mandar una campaña
POST /v1/campaigns                crea la campaña y la encola a toda la base
GET  /v1/campaigns/:id/report     entregados, pendientes y suprimidos con motivo
POST /v1/embed-tokens             token de SSO para embeber la consola en el producto
POST /v1/webhook-endpoints        registra el endpoint de webhooks del producto
GET  /health
```

Fuera de `/v1/` hay cuatro superficies más, cada una con su propia
autenticación:

| Prefijo | Quién llama | Para qué |
|---|---|---|
| `/public/*` y `/:slug` | el cliente, desde el QR | Landing white-label, OTP de alta y descarga del pase. |
| `/apple/v1/*` | el iPhone | Web service de Apple: registro de dispositivos, pases con cambios y el pase actualizado. Se autentica con el `authenticationToken` del propio pase. |
| `/embed/*` | la consola del comercio | Programa, beneficios, diseño, clientes, ubicaciones, avisos y campañas. Con el token de SSO. |
| `/admin/*` | el back-office de Sophos | Productos, comercios, certificados de Apple, auditoría de saldos, vencimiento y despachador. Con `ADMIN_API_KEY`. |

`GET /v1/memberships/lookup` devuelve `availableRewards` junto con el saldo: es
lo que hace que el cajero vea "este cliente tiene un café gratis" en el momento
en que lo busca, sin depender de ninguna notificación ni de ninguna wallet.

Cómo se integra un producto, con el SDK y la verificación de webhooks:
[docs/integracion.md](docs/integracion.md).

## Producción

### Hecho

- [x] Build compilado para producción. `pnpm build` empaqueta con esbuild a
      `dist/index.js` y copia las migraciones; `pnpm start` lo corre. El build
      falla si una dependencia de ejecución no está declarada en la raíz — así
      no se descubre al arrancar.
- [x] Deploy en Fly (`gru`, 2 máquinas, sin auto-stop) contra Neon en
      `sa-east-1`. El servicio no arranca en producción sin `DATABASE_URL`.
- [x] Trabajos periódicos dentro del propio proceso (`apps/api/src/scheduler.ts`):
      despachador de avisos, entrega de webhooks, vencimiento de puntos y alta
      de certificados de Apple. Cada corrida se reclama en `job_run`, así que
      con dos máquinas no corre dos veces.
- [x] Webhooks salientes firmados con HMAC. Ver `packages/sdk/src/signature.ts`:
      firmante y verificador comparten el módulo, para que no puedan discrepar.
- [x] Vencimiento de puntos, FIFO. `apps/api/src/expiry.ts`; corre en el
      scheduler y también se puede forzar con `POST /admin/expiry/run`.
- [x] Rate limits por comercio. `apps/api/src/rate-limit.ts`, ventana deslizante
      sobre las escrituras de `/v1/`. Vive en memoria del proceso: al escalar
      horizontalmente hay que moverlo a Postgres o Redis.
- [x] Auditoría de saldos. `auditAllBalances` en una sola consulta, expuesta en
      `GET /admin/audit/balances`. Tiene que devolver siempre la lista vacía.
- [x] Apple Wallet: alta automatizada de Pass Type IDs con certificado por
      comercio, desde el scheduler o forzada con
      `POST /admin/merchants/:id/provision-pass`.
- [x] Push de APNs verificado contra un iPhone real el 2026-09-02:
      `{sent: 1, dropped: 0, failed: 0}` y el teléfono volvió a bajar el pase.
- [x] Redimensionar los logos. `packages/passes/src/apple/resize.ts`, al emitir
      el pase. Bajó el pase de 337 KB a 12,8 KB con el mismo logo de 1024x1024.
- [x] Google Wallet fuera de demo mode y emitiendo tarjetas reales.

### Falta

- [ ] **Integrar ElMenu y Noctu.** Es lo único grande que queda del producto. El
      contrato está en [docs/integracion.md](docs/integracion.md) y el SDK ya
      trae el flujo de activación (`upsertMerchant`, `configureProgram`,
      `createEmbedToken`). Requiere los repos de esos productos.
- [ ] **Los textos legales, antes de firmar el primer comercio.** El contrato
      con comercios, y que un abogado confirme la redacción del consentimiento
      `identidad/v2` (`apps/join/src/consent.ts`) contra la Ley 7593/2025.
- [ ] **Renovar los certificados de Apple.** Vencen a los 13 meses de
      emitidos, y un pase con el certificado vencido deja de actualizarse.
      `GET /admin/pass-certificates/expiring` los lista, pero la renovación
      todavía no la dispara el scheduler.
- [ ] **Verificar las geocercas en un teléfono real**, en iOS y en Android, y el
      tope de 3 avisos cada 24 h de Google en un Android. El detalle está en
      [docs/google-wallet-verificacion.md](docs/google-wallet-verificacion.md).
- [ ] **Mover la app de Fly a un workspace de Sophos**, con un segundo miembro.
      Hoy vive en una organización personal; la base ya está en la cuenta de
      Sophos en Neon.
- [ ] NFC, si Apple aprueba el entitlement. Depende además de terminales
      certificados para Apple VAS, que en Paraguay todavía no están
      identificados. No condiciona nada.

**Ajustes manuales con PIN de staff: no va acá.** Estaba anotado como pendiente,
pero loyalty no tiene modelo de usuarios — `redeemedBy` es un string que manda el
producto. Los roles y el PIN pertenecen a ElMenu y Noctu, que sí saben quién es
cada mozo. Lo que sí corresponde de este lado es que el asiento guarde el actor
que le informan, y eso ya lo hace.
