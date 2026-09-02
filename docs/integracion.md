# Integrar un producto con Sophos Loyalty

Guía para ElMenu, Noctu y FactuFast. La integración son **tres piezas**, y las
tres se hacen desde el backend del producto — nunca desde el navegador ni desde
la app, porque las credenciales dan acceso a la base de clientes de todos tus
comercios.

1. **Emitir eventos** cuando pasa algo que suma puntos.
2. **Consultar en el POS** para que el cajero vea el saldo y los beneficios.
3. **Recibir webhooks** para enterarte sin preguntar.

---

## 0. Credenciales

Sophos te entrega un `client_id` y un `client_secret` por producto. El SDK
maneja el token solo:

```ts
import { LoyaltyClient } from "@sophos/loyalty-sdk";

export const loyalty = new LoyaltyClient({
  baseUrl: process.env.LOYALTY_API_URL!,
  clientId: process.env.LOYALTY_CLIENT_ID!,
  clientSecret: process.env.LOYALTY_CLIENT_SECRET!,
});
```

**Los comercios se identifican con TU id.** Si en ElMenu el restaurante es
`rest_8842`, ese es el `merchant` en todas las llamadas. No manejás UUIDs de
Sophos en ningún momento.

---

## 1. Activar el módulo para un comercio

Esto corre **una vez**, cuando el comercio enciende Fidelización desde tu
producto. Las tres llamadas son idempotentes: se pueden repetir en cada arranque
sin revisar si ya existen.

```ts
import { LoyaltyClient } from "@sophos/loyalty-sdk";

const loyalty = new LoyaltyClient({
  baseUrl: process.env.LOYALTY_API_URL!,
  clientId: process.env.LOYALTY_CLIENT_ID!,
  clientSecret: process.env.LOYALTY_CLIENT_SECRET!,
});

// 1. El comercio. `externalId` es su id EN TU PRODUCTO.
await loyalty.upsertMerchant({
  externalId: String(restaurante.id),
  slug: restaurante.slug,
  legalName: restaurante.razonSocial,
  displayName: restaurante.nombre,
});

// 2. Un programa inicial. Después lo edita el comercio desde la consola.
await loyalty.configureProgram({
  merchant: String(restaurante.id),
  kind: "points",
  config: { earn: [{ on: "order.paid", rate: { per: 10_000, points: 1 } }] },
});
```

### Tres cosas que conviene saber antes

**El `slug` no se puede cambiar.** Está adentro del Pass Type ID de Apple
(`pass.com.sophosgroup.l.{slug}`) y del id de clase de Google. Cambiarlo dejaría
huérfanos todos los pases ya emitidos, así que el `upsertMerchant` lo ignora en
las llamadas siguientes y **devuelve el guardado**. Si te importa saber que tu
cambio no se aplicó, comparalo con el que mandaste.

**`configureProgram` reemplaza, no combina.** Mandar solo las reglas nuevas borra
topes, vencimiento y horarios sin avisar. Llamalo una vez al activar, con un
preset; de ahí en adelante manda la consola. Si lo llamás de nuevo más tarde,
vas a pisar lo que el comercio configuró.

**`externalId` es tuyo y no colisiona con otros productos.** ElMenu y Noctu
pueden tener los dos un comercio con id `1`: son comercios distintos, con bases
de clientes distintas.

## 2. Darle la consola al comercio

Es lo que hace que el comercio configure **todo** —programa, beneficios, diseño
de la tarjeta, sucursales, notificaciones, campañas— sin salir de tu producto y
sin que ustedes construyan ninguna pantalla.

```ts
// En tu backend. El access token de producto no puede salir del servidor.
const { token } = await loyalty.createEmbedToken({
  merchant: String(restaurante.id),
  staffId: String(usuario.id),
});
```

```html
<iframe src="https://consola.sophosgroup.com.py/embed?token=TOKEN"></iframe>
```

El token dura una hora y está atado a **ese** comercio: los endpoints de la
consola ignoran cualquier `merchant` que venga en el request, así que no hay
forma de que un comercio alcance los datos de otro editando la URL.

Avisale a Sophos el dominio desde el que vas a embeberla — está restringido por
`frame-ancestors` y si no está en la lista, el iframe queda en blanco.

## 3. Emitir eventos

Cuando se cobra un pedido:

```ts
const result = await loyalty.ingestEvent({
  merchant: restaurante.id,
  idempotencyKey: pedido.id,   // ← el id del pedido en TU sistema
  type: "order.paid",
  amount: pedido.total,         // guaraníes enteros
  membership: { phone: cliente.celular },
});
```

**`idempotencyKey` no es opcional en la práctica.** Un POS con mala señal
reintenta solo, y sin esa clave el cliente acumularía dos veces por la misma
compra. Con ella, el reintento devuelve el resultado original y `duplicate: true`.

Usá el id del pedido, no un UUID nuevo por intento — si generás uno nuevo en cada
reintento, la idempotencia no sirve de nada.

### Eventos disponibles

| Producto | Evento | Cuándo |
|---|---|---|
| ElMenu | `order.paid` | Al cobrar |
| Noctu | `order.paid` | Consumo en barra |
| Noctu | `ticket.validated` | Entrada al local |
| Noctu | `table.reserved` | Reserva de VIP |
| FactuFast | `invoice.issued` | Factura emitida |

Las reglas de acumulación las configura **cada comercio** desde su consola. Tu
producto solo informa que el hecho ocurrió; cuántos puntos son no es decisión
tuya.

---

### Deshacer un consumo

Cuando un pedido se anula, se invita o no se entrega, los puntos que dejó tienen
que volver:

```ts
const r = await loyalty.reverseEvent({
  merchant: String(restaurante.id),
  idempotencyKey: String(pedido.id),   // la misma del consumo
  reason: "pedido anulado",
})
```

Va con la **misma clave** del consumo: no hace falta guardar ningún id nuestro.

**Si el cliente ya canjeó esos puntos, se descuenta lo que haya.** No se puede
des-tomar el café, y dejar el saldo en negativo sería incomprensible para él. La
respuesta trae `notRecovered` con lo que no se pudo recuperar — es plata que el
comercio entregó por un consumo que no existió, y conviene mostrárselo.

```json
{ "reversed": 5, "notRecovered": 7, "balance": 0, "duplicate": false }
```

Es idempotente: reintentar devuelve el primer resultado con `duplicate: true`.
Y si el consumo nunca llegó a sumar puntos —por el tope diario o por no alcanzar
el mínimo— responde `nothingToReverse: true`, que no es un error.

## 4. Consultar en el POS

Cuando el cajero identifica al cliente:

```ts
const cliente = await loyalty.lookupMembership(restaurante.id, {
  phone: telefonoIngresado,
});

if (!cliente) {
  // Todavía no tiene tarjeta: ofrecé darlo de alta.
  return;
}

mostrar(`${cliente.balance} ${cliente.unit === "stamps" ? "sellos" : "puntos"}`);

// Esto es lo que más importa de toda la integración:
for (const beneficio of cliente.availableRewards) {
  mostrarDestacado(`Puede canjear: ${beneficio.name}`);
}
```

`availableRewards` es el momento en que el programa se vuelve real. Si el cajero
no lo ve, el cliente no canjea, y un programa donde nadie canjea no retiene a
nadie.

Devuelve `null` si el cliente no tiene tarjeta — es un resultado esperable, no un
error.

### Canjear

```ts
const canje = await loyalty.redeem({
  merchant: restaurante.id,
  rewardId: beneficio.id,
  membership: { id: cliente.membershipId },
  redeemedBy: `staff:${usuario.id}`,   // queda en el registro de auditoría
});

if (!canje.ok && canje.reason === "insufficient_balance") {
  mostrarError("No alcanza el saldo.");
}
```

---

## 5. Recibir webhooks

Registrás tu URL una vez:

```bash
curl -X POST $LOYALTY_API_URL/v1/webhook-endpoints \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"https://api.elmenu.com.py/hooks/loyalty"}'
```

Te devuelve un `secret` **una sola vez**. Guardalo: no se puede volver a
consultar.

### Verificar la firma — obligatorio

Sin verificar, cualquiera que descubra tu URL puede inventar canjes y saldos.

```ts
import { verifySignature, SIGNATURE_HEADER } from "@sophos/loyalty-sdk";

app.post("/hooks/loyalty", async (req, res) => {
  // El cuerpo CRUDO, sin parsear. Si lo convertís a objeto y lo volvés a
  // serializar, el orden de las claves puede cambiar y la firma no coincide.
  const raw = await leerCuerpoCrudo(req);

  const check = verifySignature(raw, req.headers[SIGNATURE_HEADER], SECRET);
  if (!check.valid) return res.status(401).send({ error: check.reason });

  const evento = JSON.parse(raw);
  // ...
});
```

La firma incluye un timestamp y se rechaza pasados 5 minutos, así que una
entrega capturada no se puede reenviar mañana.

### Deduplicar

Un reintento tras un timeout puede llegar dos veces aunque ya lo hayas
procesado. **`eventId` es el mismo en todos los reintentos** — guardalo y
descartá los repetidos.

### Eventos que recibís

| Evento | Para qué |
|---|---|
| `membership.created` | Un cliente se sumó al programa |
| `membership.balance_changed` | Cambió el saldo |
| `reward.available` | **Desbloqueó un beneficio** — el más accionable |
| `membership.tier_changed` | Subió o bajó de nivel |
| `redemption.completed` | Canjeó algo |

`reward.available` se dispara **solo al cruzar el umbral**, no en cada consumo
posterior. Si lo repitiéramos, el cajero dejaría de mirarlo.

### Reintentos

Cinco intentos con espera creciente: 1 min, 5, 30, 2 h y 6 h. Después la entrega
queda como `exhausted` y **se conserva** — así se puede responder "¿por qué mi
POS no mostró el beneficio?" con datos en vez de suposiciones.

Respondé `2xx` rápido. Si tu handler tarda, encolá y respondé igual: un timeout
cuenta como fallo y dispara reintentos.

---

## Lo que NO tenés que hacer

- **No guardes saldos en tu base.** El saldo vive en el ledger de loyalty. Una
  copia se desincroniza y termina discutiendo con el cliente sobre cuál vale.
- **No calcules puntos.** Las reglas son del comercio y cambian sin avisarte.
- **No pongas el `clientSecret` en el front.** Da acceso a los clientes de todos
  tus comercios.
- **No inventes un `idempotencyKey` por intento.** Usá el id del pedido.

---

