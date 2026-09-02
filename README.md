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
| 2 | Google Wallet: emisión, sincronización, geocercas, diseño | ✅ |
| 2 | Despachador de notificaciones: cupo, prioridad, agrupamiento, campañas | ✅ |
| 2 | Alta con OTP, consola embebible | pendiente |
| 3 | Integración con ElMenu y Noctu | pendiente |
| 4 | Apple Wallet | pendiente |

**Google Wallet quedó habilitado el 2026-08-13**: el Issuer existe
(`3388000000023171859`), el publishing access está aprobado y la cuenta salió de
demo mode — cualquiera puede guardar una tarjeta y desaparece el prefijo
`[TEST ONLY]`. Falta emitir la primera tarjeta real contra ese Issuer. Sin
credenciales cargadas, `/v1/passes` responde 503 y todo lo demás sigue
funcionando igual. Antes de salir a producción hay que recorrer
[docs/google-wallet-verificacion.md](docs/google-wallet-verificacion.md), que
lista los valores que la documentación de Google define de forma contradictoria.

**El enrollment de Apple está aprobado** desde el 2026-09-01, así que la fase 4
ya no está bloqueada por trámite. El entitlement de NFC se pidió el mismo día y
está en revisión, pero el v1 va con QR y no depende de él.

## Estructura

```
packages/rules   motor de reglas declarativo, puro y sin dependencias
packages/db      esquema, migraciones y conexión (PGlite en dev, Postgres en prod)
packages/passes  Google Wallet: builders, firma de save links, cliente REST
apps/api         API pública: OAuth2, ingesta, tarjetas, canjes, pases
```

## Comandos

```bash
pnpm install
pnpm test          # 197 casos en 12 archivos
pnpm typecheck
pnpm dev           # levanta la API en :4001
```

Sin `DATABASE_URL` la API levanta **PGlite en memoria** — Postgres real compilado
a WASM, sin servidor que instalar. Sirve para desarrollo, pero pierde todo al
reiniciar. Con `DATABASE_URL` apunta al Postgres de Fly y corre las mismas
migraciones.

### Variables

| Variable | Obligatoria | Para qué |
|---|---|---|
| `DATABASE_URL` | en producción | Postgres. Sin ella, PGlite en memoria. |
| `JWT_SIGNING_KEY` | en producción | Firma de los access token. Si cambia, todos los productos integrados pierden sus tokens. |
| `PORT` | no | Por defecto 4001. |
| `GOOGLE_WALLET_ISSUER_ID` | para emitir | Issuer de Sophos: `3388000000023171859`. |
| `GOOGLE_WALLET_SA_EMAIL` | para emitir | Service account de GCP. |
| `GOOGLE_WALLET_SA_PRIVATE_KEY` | para emitir | Clave privada PEM. Acepta los `\n` escapados del JSON de GCP. |
| `GOOGLE_WALLET_ORIGINS` | no | Dominios autorizados a mostrar el botón de guardado. |

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

6. **Una caída de Google no puede romper una acumulación.** El cliente ya
   consumió y sus puntos le corresponden. La sincronización del pase corre fuera
   de la transacción del asiento, no propaga excepciones, y deja el desfasaje
   registrado en `pass_instance` para que la reconciliación lo levante después
   (`GET /v1/passes/pending-sync`).

7. **Ninguna notificación se pierde en silencio.** Cada intento deja una fila:
   la que se manda y también las que se agrupan o se descartan, con el motivo.
   Es lo que permite responderle a un comercio por qué su campaña llegó a 453
   de 500 en vez de mostrarle un "enviado" plano.

8. **Una campaña nunca puede dejar sin aviso a un cliente que consume.** Las
   campañas tienen un cupo menor que el total (`CAMPAIGN_BUDGET`), reservando
   lugar para lo transaccional. La prioridad sola no alcanza: solo ordena lo que
   está pendiente al mismo tiempo, y una notificación ya enviada no se devuelve.

## Decisiones que conviene conocer antes de tocar el código

- **Los multiplicadores no se acumulan entre sí: se aplica el mayor.** "Jueves
  x2" y "cumpleaños x3" el mismo día dan x3, no x6. Multiplicarlos convertiría
  dos promos razonables en un pasivo que el comercio no dimensionó.

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
POST /v1/redemptions              canje de un beneficio
PUT  /v1/design                   diseño de la tarjeta (logo, colores, etiquetas)
POST /v1/locations                geocercas del comercio (máximo 10)
POST /v1/passes                   emite la tarjeta y devuelve el save link
GET  /v1/passes/pending-sync      pases desfasados: la cola de reconciliación
GET  /v1/campaigns/reach          alcance real antes de mandar una campaña
POST /v1/campaigns                crea la campaña y la encola a toda la base
GET  /v1/campaigns/:id/report     entregados, pendientes y suprimidos con motivo
POST /v1/notifications/dispatch   corre una pasada del despachador
GET  /health
```

`GET /v1/memberships/lookup` devuelve `availableRewards` junto con el saldo: es
lo que hace que el cajero vea "este cliente tiene un café gratis" en el momento
en que lo busca, sin depender de ninguna notificación ni de ninguna wallet.

## Pendiente antes de producción

- [x] Build compilado para producción. `pnpm build` empaqueta con esbuild a
      `dist/index.js` y copia las migraciones; `pnpm start` lo corre. El build
      falla si una dependencia de ejecución no está declarada en la raíz — así
      no se descubre al arrancar.
- [x] Webhooks salientes firmados con HMAC. Ver `packages/sdk/src/signature.ts`:
      firmante y verificador comparten el módulo, para que no puedan discrepar.
- [x] Vencimiento de puntos. `apps/api/src/expiry.ts`, expuesto en
      `POST /admin/expiry/run` para que lo dispare un cron.
- [x] Rate limits por comercio. `apps/api/src/rate-limit.ts`, ventana deslizante
      sobre las escrituras de `/v1/`. Vive en memoria del proceso: al escalar
      horizontalmente hay que moverlo a Postgres o Redis.
- [x] Auditoría de saldos. `auditAllBalances` en una sola consulta, expuesta en
      `GET /admin/audit/balances`. Tiene que devolver siempre la lista vacía.
- [x] Apple Wallet: alta automatizada de Pass Type IDs con certificado por
      comercio. `POST /admin/merchants/:id/provision-pass`. Probado una vez
      contra la API real de Apple.
- [ ] Verificar el push de APNs contra un teléfono. Hace falta un push token
      real, y el dispositivo solo lo entrega tras registrarse contra el web
      service — o sea, después del deploy.
- [x] Redimensionar los logos. `packages/passes/src/apple/resize.ts`, al emitir
      el pase. Bajó el pase de 337 KB a 12,8 KB con el mismo logo de 1024x1024.

**Ajustes manuales con PIN de staff: no va acá.** Estaba anotado como pendiente,
pero loyalty no tiene modelo de usuarios — `redeemedBy` es un string que manda el
producto. Los roles y el PIN pertenecen a ElMenu y Noctu, que sí saben quién es
cada mozo. Lo que sí corresponde de este lado es que el asiento guarde el actor
que le informan, y eso ya lo hace.
