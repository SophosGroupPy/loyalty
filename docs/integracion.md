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

## 1. Emitir eventos

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

## 2. Consultar en el POS

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

## 3. Recibir webhooks

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

## Consola embebida

Para que el comercio configure su programa sin salir de tu producto, pedí un
token y embebé la consola:

```ts
const { token } = await fetch(`${API}/v1/embed-tokens`, {
  method: "POST",
  headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
  body: JSON.stringify({ merchant: restaurante.id, staffId: usuario.id }),
}).then((r) => r.json());
```

```html
<iframe src="https://consola.sophosgroup.com.py/embed?token=TOKEN"></iframe>
```

El token dura una hora y está atado a **ese** comercio: los endpoints ignoran
cualquier `merchant` que venga en el request, así que no hay forma de que un
comercio alcance los datos de otro editando la URL.

Avisale a Sophos el dominio desde el que vas a embeberla — está restringido por
`frame-ancestors` y si no está en la lista, el iframe queda en blanco.
