# Sophos Loyalty

Módulo de fidelidad con tarjetas en wallet para el ecosistema Sophos Group
(ElMenu, Noctu, FactuFast).

No es un programa de fidelidad global: **cada comercio tiene su propio programa y
emite su propia tarjeta**, con su propio saldo. Lo único compartido entre
comercios es el registro de la persona, identificado por celular verificado, y
solo sirve para que el segundo alta del ecosistema sea de un toque.

Plan completo de arquitectura: `~/.claude/plans/estamos-desarrollando-un-programa-silly-mccarthy.md`

## Estado

**Fase 1 completa** — motor de reglas, ledger, API de ingesta y aviso al POS.
Todavía sin wallets: la fase 1 se valida con tarjeta web + QR y no depende ni de
Apple ni de Google.

| Fase | Alcance | Estado |
|---|---|---|
| 1 | Motor, ledger, API, aislamiento multi-tenant, aviso al POS | ✅ |
| 2 | Google Wallet, alta con OTP, consola embebible, notificaciones | pendiente |
| 3 | Integración con ElMenu y Noctu | pendiente |
| 4 | Apple Wallet (bloqueada por el enrollment) | pendiente |

## Estructura

```
packages/rules   motor de reglas declarativo, puro y sin dependencias
packages/db      esquema, migraciones y conexión (PGlite en dev, Postgres en prod)
apps/api         API pública: OAuth2, ingesta de eventos, tarjetas, canjes
```

## Comandos

```bash
pnpm install
pnpm test          # 50 tests
pnpm typecheck
pnpm dev           # levanta la API en :3001
```

Sin `DATABASE_URL` la API levanta **PGlite en memoria** — Postgres real compilado
a WASM, sin servidor que instalar. Sirve para desarrollo, pero pierde todo al
reiniciar. Con `DATABASE_URL` apunta al Postgres de Railway y corre las mismas
migraciones.

### Variables

| Variable | Obligatoria | Para qué |
|---|---|---|
| `DATABASE_URL` | en producción | Postgres. Sin ella, PGlite en memoria. |
| `JWT_SIGNING_KEY` | en producción | Firma de los access token. Si cambia, todos los productos integrados pierden sus tokens. |
| `PORT` | no | Por defecto 3001. |

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
GET  /health
```

`GET /v1/memberships/lookup` devuelve `availableRewards` junto con el saldo: es
lo que hace que el cajero vea "este cliente tiene un café gratis" en el momento
en que lo busca, sin depender de ninguna notificación ni de ninguna wallet.

## Pendiente antes de producción

- [ ] Reemplazar `tsx` por un build compilado para el runtime de producción.
- [ ] Webhooks salientes firmados con HMAC (`reward.available`, `balance_changed`).
- [ ] Vencimiento de puntos (`expiry` ya se configura, falta el job que lo aplica).
- [ ] Ajustes manuales con PIN de staff y audit log.
- [ ] Rate limits por comercio y por membresía.
- [ ] Auditoría periódica de saldos con `auditBalance`.
