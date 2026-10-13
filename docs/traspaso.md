# Traspaso a desarrollo

**Al 2026-10-13.** Escrito el 2026-09-01; actualizado con Google Wallet y Apple
Wallet en producción.

La arquitectura, las invariantes y el contrato de integración ya están escritos
en este repo. Este documento es la capa que no está ahí: el estado de los
trámites externos, las credenciales vivas, las decisiones detrás de Apple
Wallet, las trampas ya pagadas y el orden en que conviene atacar lo que queda.

---

## 0. Leer primero, y no duplicar

El repo se documenta a sí mismo. Antes de tocar nada, tres lecturas en este
orden:

| Archivo | Qué contiene |
|---|---|
| [`README.md`](../README.md) | Arquitectura, las ocho invariantes que no se negocian, las decisiones de producto que no son evidentes desde el código, el listado completo de endpoints y lo que falta para producción. **Es la fuente de verdad.** |
| [`docs/integracion.md`](integracion.md) | Cómo se integra un producto: credenciales, eventos, consultas del POS, webhooks y verificación de firma. |
| [`docs/google-wallet-verificacion.md`](google-wallet-verificacion.md) | Los valores que la documentación de Google define de forma contradictoria, y cuáles se verificaron contra la API real. |

Suite al momento de escribir esto: **446 casos en 26 archivos**, todos pasando.
Las invariantes del README están cubiertas por tests — si alguna se rompe, la
suite falla. Esa es la red de seguridad para tocar el motor de reglas o el
ledger.

---

## 1. Estado de los trámites externos

| Frente | Estado | Detalle |
|---|---|---|
| Google Wallet | **En producción** | Publishing access concedido el 2026-08-13. La cuenta salió de demo mode: cualquiera puede guardar una tarjeta, sin el prefijo `[TEST ONLY]`, y ya se emiten tarjetas reales contra el Issuer. |
| Apple Developer Program | **Activo** | Membresía de organización desde el 2026-09-01. App Store Connect habilitado. Vendedor: `SOPHOS GROUP E.A.S.` |
| Apple Wallet | **En producción** | Ciclo completo verificado el 2026-09-02 contra un iPhone real. El alta del Pass Type ID y el certificado de cada comercio es automática. Ver la sección 3. |
| Entitlement NFC de Apple | **En revisión** | Solicitado el 2026-09-01. Aprobación discrecional. Se declararon **0 terminales con Apple VAS desplegados**, que es la verdad. |
| Clase `don-julio` | **Publicada** | Era la clase de prueba de un restaurante ficticio. Al conceder el publishing access, Google publicó automáticamente toda clase en Active. Hoy figura `APPROVED`. |
| Infraestructura | **Desplegado** | Fly.io, app `sophos-loyalty` en `gru` (São Paulo), 2 máquinas. Sirve en https://tarjeta.sophosgroup.com.py (y https://sophos-loyalty.fly.dev). |
| Base de datos | **Neon** | Proyecto `sophos-loyalty` (id `soft-recipe-58331315`), base `loyalty`, región AWS `sa-east-1` (São Paulo) — la misma ciudad que la app. Cuenta de Sophos, no la personal. |

### `don-julio` está quemado

Es el restaurante ficticio con el que se probó toda la capa de Apple. Su clave
privada de firma quedó expuesta el 2026-09-01, y como **Apple no permite revocar
certificados de Pass Type ID**, ese identificador queda comprometido para
siempre: cualquiera con esa clave puede firmar pases a su nombre.

El daño real es nulo —el comercio no existe y la clave no sirve para ningún
otro— pero el identificador **no puede usarse nunca para un comercio real**. Eso
está impuesto en código, no en este documento: `BURNED_PASS_TYPE_IDS` en
`apps/api/src/provisioning.ts` corta el alta antes de hablar con Apple, y el
back-office muestra el motivo.

El guard va en el provisioning y no en el alta de comercios a propósito: un
comercio llamado don-julio en una base de pruebas no hace daño, y ponerlo ahí
habría roto 109 tests sin ganar seguridad.

### Sobre la clase `don-julio` de Google

La consola **no ofrece archivar ni eliminar** una clase: el desplegable de
Status solo tiene `DRAFT` y `UNDER_REVIEW`. Peor, el formulario de edición
precarga valores que no coinciden con lo guardado — muestra `UNDER_REVIEW` y
`MULTIPLE_HOLDERS` donde lo almacenado es `APPROVED` y vacío — así que guardar
desde la UI escribe cambios que nadie pidió.

Si se quiere despublicar, hacerlo **por API** con un `PATCH` que toque solo
`reviewStatus`. El riesgo real es bajo: una clase de fidelidad no es
descubrible por consumidores, solo se obtiene con el link de guardado.

---

## 2. Credenciales e identificadores

El Issuer ID no es secreto — viaja dentro de cada pase. La clave privada de la
service account sí lo es y no va al repo.

### Google Wallet

```
Issuer ID        3388000000023171859
Service account  loyalty-issuer@loyalty-sophos.iam.gserviceaccount.com
Proyecto GCP     loyalty-sophos
Merchant ID      BCR2DN6D3KFLZNRV
```

> **No confundir.** El Merchant ID de Google Pay (`BCR2DN6D3KFLZNRV`) y el
> Issuer ID de Wallet (`3388000000023171859`) son cosas distintas. El Merchant
> ID **no** sirve para la Wallet API.
>
> Y la autorización de Wallet **no usa roles de IAM de GCP**: se otorga
> invitando a la service account en Pay & Wallet Console → Users, con rol
> Developer. Sin eso, la API responde `403 Permission denied` sin más pista.

### Apple

```
Apple ID de la cuenta  dev@sophosgroup.com.py
Entidad legal          SOPHOS GROUP E.A.S.
Team ID                3W23SYPG6H
D-U-N-S                955801894
Enrollment ID          PQLR6DGS4Y
```

El Team ID va en `teamIdentifier` de cada pase. No es secreto: viaja adentro del
`.pkpass` y aparece en el `OU` del certificado.

**Pass Type IDs.** Uno por comercio, con la forma
`pass.com.sophosgroup.l.<slug>` — ver la sección 3. Como el alta es automática,
la lista viva no se mantiene acá: está en la pantalla de certificados del
back-office, en `GET /admin/pass-certificates`, y
`./scripts/provisionar-apple.sh` sin argumentos lista qué comercios pueden
emitir en iPhone y cuáles no. El único que conviene recordar es el que **no**
se puede usar: `pass.com.sophosgroup.l.don-julio`.

Los certificados de Pass Type ID **vencen a los 13 meses** —el de Don Julio,
emitido el 2026-09-01, vence el 2027-10-01—. Con un certificado por comercio,
la renovación deja de ser un trámite anual y pasa a ser un calendario.
`GET /admin/pass-certificates/expiring` los lista, pero **la renovación todavía
no la dispara el scheduler**: hay que automatizarla antes de que venzan los
primeros, o un día los pases de algún comercio dejan de poder actualizarse.

**Material de firma.** Con el alta automática, la clave privada se genera en el
servidor y no sale nunca de ahí: se guarda cifrada con AES-256-GCM en
`pass_certificate`, y la clave de cifrado (`APPLE_PASS_ENCRYPTION_KEY`) vive en
los secretos de Fly, nunca en la base. A Apple solo viaja el CSR. `certs/`
quedó para el material manual de Don Julio y el intermedio `wwdr.pem`, que usa
`scripts/emit-apple.ts`; está en `.gitignore` y en `.dockerignore`.

### Variables de entorno

El detalle completo está en el README. Las que importan en producción:

| Variable | Nota |
|---|---|
| `DATABASE_URL` | Sin ella la API levanta PGlite en memoria y pierde todo al reiniciar. El servicio aborta el arranque si `NODE_ENV=production` y falta. |
| `JWT_SIGNING_KEY` | Tiene que ser estable. Si cambia, todos los productos integrados pierden sus tokens. |
| `ADMIN_API_KEY` | Acceso al back-office. Ve todo el ecosistema. |
| `GOOGLE_WALLET_SA_PRIVATE_KEY` | PEM. Acepta los `\n` escapados tal como vienen en el JSON de GCP. |
| `APPLE_PASS_ENCRYPTION_KEY` | Si se pierde, no se puede descifrar ninguna clave de firma y hay que pedirle a Apple certificados nuevos para todos los comercios. |
| `APPLE_ASC_PRIVATE_KEY` | La `.p8` de la App Store Connect API, con rol Admin. Sin ella el alta de certificados vuelve a ser manual. |

---

## 3. Apple Wallet — fase 4

Construida y en producción desde septiembre. Esta sección guarda las decisiones
que le dan forma, para que no se vuelvan a discutir, y dónde vive cada pieza.

### Un Pass Type ID por comercio, no uno global

Es la decisión estructural de la fase y la más fácil de hacer mal, porque el
impulso natural es crear uno solo para todo el ecosistema.

Apple agrupa las tarjetas en la Wallet del cliente por `passTypeIdentifier` más
tipo de pase. Con un identificador compartido, las tarjetas de todos los bares
y restaurantes se le apilan juntas al cliente en una sola pila. El campo
`groupingIdentifier`, que serviría para separarlas, **solo aplica a
`eventTicket` y `boardingPass`** — no a las tarjetas de fidelidad.

Cada Pass Type ID necesita además su propio certificado de firma. Las dos cosas
se piden por la App Store Connect API, así que dar de alta un comercio nuevo no
es un trámite manual.

### El branding va en el pase, no en un registro de Apple

Cada comercio lleva su propia marca en su tarjeta, y eso sale del `.pkpass`
mismo:

- `organizationName` — el nombre del comercio
- `logoText` — el texto junto al logo; por defecto, el nombre del comercio
- `logo.png` — el logo del comercio, en @1x, @2x y @3x
- `strip.png` — la foto de la banda: el plato, el salón
- `backgroundColor`, `foregroundColor`, `labelColor`

Se define al emitir, por comercio, y **no requiere ninguna aprobación de
Apple**. Sophos aparece solo en la cadena del certificado, nunca en la cara del
pase. Bajo el código va "Powered by" y el producto dueño del comercio —elMenu,
Noctu—, resuelto en cada emisión y no escrito a mano.

> **Descartado, para que no se vuelva a plantear.** Apple Business Register no
> es la palanca para esto. Registra la marca de la propia organización para
> Maps, Siri y algunas superficies de Wallet, y exige declarar que sos dueño de
> esa marca — o sea que Sophos no puede registrar las marcas de sus comercios.
> Si un comercio quiere presencia verificada en Apple, la tramita él con su
> propia organización.

### Los sellos se dibujan dentro de la banda

Apple no deja dibujar nada: el pase tiene ranuras fijas y una sola imagen
ancha. Así que en un programa de sellos los casilleros se rinden **dentro de la
banda**, generada de nuevo en cada descarga, con la foto del comercio de fondo y
el ícono que el comercio sube dentro de cada sello. En Google no se puede: la
imagen "hero" es por clase, no por tarjeta, así que ahí los sellos se muestran
como número. Es un límite de la plataforma, no un pendiente.

### QR primero, NFC después

El v1 de Apple Wallet va con código de barras, igual que Google. El NFC depende
de tres cosas simultáneas: el entitlement de Apple (en revisión), terminales
certificados para Apple Pay VAS, y un software de caja que soporte los modos
«VAS Only» y «Payment and VAS».

En Paraguay el eslabón que no controlamos es el segundo: los comercios corren
POS en Windows y los pagos van por pinpads del adquirente, y todavía no está
identificado qué modelos son ni si soportan VAS. **No bloquear nada por esto.**

### Dónde vive cada pieza

Apple entró como un segundo emisor detrás de la misma interfaz que Google, no
como una rama paralela: el diseño y la identidad del comercio se comparten.

| Pieza | Dónde |
|---|---|
| `pass.json`, manifiesto, firma PKCS#7 separada y zip del `.pkpass` | `packages/passes/src/apple/`. Los tests lo validan con el `unzip` y el `openssl` del sistema, no con el mismo código que lo escribe. |
| Logos y banda reducidos a las medidas de Apple, sellos dibujados | `packages/passes/src/apple/resize.ts` y `stamps.ts` |
| Cliente de la App Store Connect API (JWT ES256 con la `.p8`) | `packages/passes/src/apple/asc.ts` |
| Web service: registro de dispositivos, pases con cambios, log | `apps/api/src/apple.ts`, rutas `/apple/v1/*` |
| Emisión con el certificado del comercio | `apps/api/src/apple-pass.ts` |
| Push de payload vacío que despierta al teléfono | `apps/api/src/apns.ts` |
| Alta del material de firma | `apps/api/src/provisioning.ts` |

**La entrega al cliente.** El producto llama a `POST /v1/passes/apple` y recibe
un link firmado a `/public/passes/:token`, que es lo que abre el teléfono. El
token es la credencial —el cliente nunca creó una cuenta—, vive una hora por
defecto y hasta una semana si el link viaja por correo. Si el comercio todavía
no tiene certificado, responde 409 en vez de un link que reviente en la mano
del cliente. La landing `/:slug` detecta iPhone o Android y ofrece el botón que
corresponde.

**El alta del material de firma es un trabajo del scheduler**
(`apple-provisioning`): le da Pass Type ID y certificado a todo comercio que no
los tenga, así que activar el módulo alcanza. Va en el scheduler y no en el alta
del comercio a propósito: si Apple está caído, dar de alta un comercio tiene que
seguir funcionando. Como cada alta quema un identificador permanente, tiene dos
frenos: un tope por tanda, y espera creciente de hasta seis horas ante un
rechazo, con el motivo guardado. Se puede forzar con
`POST /admin/merchants/:id/provision-pass` o con el script.

Sirve igual para renovar: el Pass Type ID se reusa —cambiarlo dejaría huérfanos
los pases ya emitidos— y solo se pide un certificado nuevo.

El CSR se arma a mano en DER porque Node no lo trae y una librería de ASN.1 para
veinte bytes es desproporcionada. Se valida con `openssl` en los tests, no con el
mismo código que lo escribe.

**Los avisos.** Apple no tiene un "mandar mensaje". La novedad se guarda en
`pass_instance.news`, viaja en el `.pkpass` con `changeMessage`, y un push de
APNs despierta al teléfono para que lo vuelva a bajar. El resultado del push
queda en `pass_instance.last_error`: es lo que permite distinguir "Apple lo
rechazó" de "el teléfono todavía no sincronizó". La fila de `pass_instance` de
Apple se crea cuando el dispositivo se registra (migración 0013); sin ella el
web service le contestaba al iPhone "nada cambió" y las tarjetas no se
actualizaban solas.

Cambiar el diseño o las geocercas también llega a los pases ya instalados: se
marcan como cambiados y se empuja a cada dispositivo del comercio.

```
App Store Connect API
  Key ID     75X4838467
  Issuer ID  11b2d435-c4c2-417d-9a0a-bb2b0583b000
  Rol        Admin
```

La clave `.p8` **se descarga una sola vez** y no está en el repo. Ojo con el
alcance: con rol Admin puede tocar toda la cuenta de desarrollador, no solo los
pases.

### Verificado en producción el 2026-09-02

El ciclo completo de Apple, contra un iPhone real y `tarjeta.sophosgroup.com.py`:

1. El servidor le pidió a Apple un Pass Type ID y un certificado, sin que nadie
   entrara al portal.
2. Emitió el `.pkpass` firmado con ese certificado.
3. El iPhone lo agregó y se registró contra el web service (201).
4. Se cambió el saldo y se disparó el push: APNs respondió
   `{sent: 1, dropped: 0, failed: 0}`.
5. El teléfono se despertó, preguntó con `passesUpdatedSince` **usando la marca
   que le habíamos dado**, y volvió a bajar el pase.

El paso 5 confirma además el arreglo de la precisión de milisegundos: con
`timestamptz` por defecto, el dispositivo habría re-descargado el pase en cada
despertar, para siempre.

**`apns-push-type` se omite y funciona.** Era el valor que quedaba en duda; con
el header ausente, APNs acepta el envío y el teléfono reacciona. Queda como está.

### Lo que sigue sin verificarse

| Qué | Por qué no se pudo |
|---|---|
| La geocerca en iOS | Necesita estar cerca del local con el pase instalado. El radio pasó de 100 m a 500 m el 2026-09-11: a 100 m la tarjeta aparecía cuando el cliente ya estaba en la puerta. |
| La geocerca en Android | Requiere un Android real cerca del local |
| El tope de 3 notificaciones por pase cada 24 h de Google | Requiere un Android real y repetir envíos |

### Tamaño de las imágenes

**Resuelto.** El logo y la banda se reducen a las medidas de Apple al emitir el
pase (`packages/passes/src/apple/resize.ts`). Con el mismo logo de 1024x1024, el
`.pkpass` pasó de **337 KB a 12,8 KB**. Importa porque el pase se rebaja entero
en cada cambio de saldo: ese peso es tráfico recurrente, no un costo único.

Quedan topes al archivo que se **descarga** —512 KB para el logo, 5 MB para la
foto de la banda, que de verdad pesa más—, porque no conviene bajar 10 MB para
después achicarlos.

**Lo que falta afinar.** Se redimensiona en cada emisión y no se cachea el
resultado. Con muchos pases del mismo comercio es trabajo repetido; cuando
moleste, lo natural es guardar las imágenes ya reducidas junto al diseño del
comercio y regenerarlas solo cuando cambie la URL de origen. La banda de sellos
no entra en ese caché: depende del saldo de cada cliente.

---

## 4. Trampas ya pagadas

Cosas verificadas contra la API real que la documentación no dice, o dice mal.
Están acá para que nadie las vuelva a descubrir.

### Google

| Tema | Qué pasa |
|---|---|
| `notifyPreference` | El valor correcto es `NOTIFY_ON_UPDATE`, no `NOTIFY`. La referencia REST de Google está equivocada: la API rechaza `NOTIFY` con `INVALID_ARGUMENT`. Verificado el 2026-08-12. |
| Documentación de Google | Se contradice a sí misma en varios puntos. Ante un valor dudoso, probarlo contra la API antes que confiar en la referencia. |
| Aprobación de clases | Las clases se aprueban solas: vuelven `approved` pese a enviarse como `UNDER_REVIEW`. Dar de alta un comercio nuevo es instantáneo. |
| Actualización de saldo | Verificado contra la API real: el saldo se actualiza en una tarjeta ya guardada sin reemitirla. |
| El objeto nace cuando alguien guarda | Si el objeto solo viaja en el JWT del link, no existe hasta que la persona guarda la tarjeta. Quien guardó solo en Apple, o no guardó, dejaba `addMessage` y la sincronización en 404 para siempre. Ahora se crea del lado del servidor al emitir, y ante un 404 se reconstruye y se reintenta una vez. |
| Diseño en la clase, saldo en el objeto | Colores, logo, imagen y geocercas viven en la clase. Parchear el objeto actualiza los puntos pero no el diseño: un cambio de diseño re-registra la clase del comercio, que actualiza todas sus tarjetas de una. |
| Tope de notificaciones | 3 por tarjeta cada 24 h, regla de Google. Apple no publica una. Se controla del lado de Sophos porque el Issuer es único para todo el ecosistema: si un comercio abusa, el throttling afecta a todos. |

### Apple

| Tema | Qué pasa |
|---|---|
| Revocar un Pass Type ID | **No se puede** desde la API ni desde el portal. La API responde 403 con "This certificate can only be revoked by Apple Developer Program Support", y la página del certificado solo ofrece descargarlo. La única salida es abrir un caso con soporte. Verificado el 2026-09-01. |
| Nombres con acento | La App Store Connect API rechaza entero un `name` con caracteres fuera de ASCII. Un comercio paraguayo con tilde o eñe es el caso normal, así que se translitera: "ElMenú" queda "ElMenu", no "ElMen". Es solo la etiqueta del portal; no toca el Pass Type ID ni lo que ve el cliente. |
| PassKit no baja lo que no cambió | El teléfono solo vuelve a bajar el pase si `content_updated_at` avanzó, y solo pregunta si le llega un push. Un cambio que no hace las dos cosas se guarda en la base y nunca llega al iPhone. |
| Un PNG roto tumba el pase entero | iOS rechaza el `.pkpass` completo si una imagen está corrupta, sin decir cuál. Pasó con una banda de 65 bytes que ningún test miraba: ahora los tests decodifican la imagen, no solo comprueban que esté en el zip. |
| `primaryFields` sobre la banda | Apple los dibuja encima de la imagen. En sellos taparían los casilleros, así que ahí la cuenta va al cuerpo del pase. |

### Infraestructura

| Tema | Qué pasa |
|---|---|
| `.dockerignore` | El contexto de build sube el directorio **tal como está en disco**, no lo commiteado. El `.gitignore` no protege ahí, y un secreto que entre en una capa queda en la imagen aunque se borre después. Por eso el `.dockerignore` excluye `certs/`, `.env.local` y todo `*.p8`, `*.pem` y `*.key`. |
| Parámetros de ruta en Fastify | Fastify los limita a 100 caracteres por defecto y un JWT mide más: la descarga del pase contestaba 414 antes de mirar la ruta. |
| `fly ssh console -C` | Imprime "Connecting to ..." junto con la salida del comando. Capturar un secreto así le pega el banner adelante, y el 401 resultante parece "la clave está mal" cuando está mal *leída*. |
| Build de Next en Vercel | Vercel construye cada app aislada con npm y no le llegan las devDependencies de la raíz del workspace. Por eso `apps/join` y `apps/console` declaran `typescript` y `@types/node` propios. |

Queda sin verificar lo que requiere un teléfono real cerca del local: las
geocercas en las dos plataformas y el comportamiento efectivo del tope de
notificaciones de Google. El detalle de cómo probarlo está en
[`docs/google-wallet-verificacion.md`](google-wallet-verificacion.md).

---

## 5. Bloqueantes que no son código

Ninguno se resuelve programando. Los dos que siguen abiertos —los textos
legales y el workspace de Fly— son más difíciles de revertir que cualquier
decisión técnica de este proyecto.

### El repo — resuelto

**https://github.com/SophosGroupPy/loyalty**, privado.

Está bajo la cuenta `SophosGroupPy` y no bajo una organización: al publicarlo,
esa cuenta no veía ninguna organización. Conviene transferirlo cuando se
resuelva —GitHub conserva historial e issues y redirige la URL vieja— pero no
bloquea nada. Mientras tanto, para pushear hace falta esa cuenta o ser
colaborador del repo: cualquier otra recibe 403.

Se verificó antes de publicar que el historial completo no tuviera claves ni
contraseñas: los únicos matches eran textos de ejemplo de un formulario y la
línea que arma un PEM.

### Los dos textos legales

Se escriben **antes de firmar el primer comercio**, y determinan si el
marketplace de consumidor queda posible o clausurado para siempre:

- **El contrato con comercios** — evitar la cláusula estándar «Sophos no usará
  los datos para ningún otro fin».
- ~~**La segunda casilla de consentimiento del alta**~~ — **hecho.** La
  redacción `identidad/v2` nombra también el segundo fin posible sin prometerlo.
  El catálogo de textos está en `apps/join/src/consent.ts`, con el id pegado al
  texto que etiqueta y las versiones retiradas conservadas. Falta que un abogado
  la confirme contra la Ley 7593/2025 antes de firmar el primer comercio.

Dejar la puerta abierta hoy cuesta cero: es solo cómo se redactan dos textos.
Cerrarla es irreversible en la práctica — renegociar con decenas de comercios
ya firmados no pasa, y volver a pedir consentimiento a una base ya dada de alta
tiene una tasa de respuesta miserable. Nada de esto se le promete al comercio
ni al cliente final; es solo no cerrarse la opción.

### Dónde vive cada cosa

La app está en la organización **personal** de Fly (`fedeventre1@gmail.com`) y la
base en la cuenta de **Sophos** en Neon. Es deliberado: lo sensible —celulares
verificados, historial de consumo, claves de firma cifradas— quedó desde el
día uno donde corresponde, y la app se mueve con `fly apps move` cuando haga
falta, que es la parte fácil.

**La región `eze` está deprecada en Fly.** El primer deploy falló por eso. `gru`
resultó mejor de todos modos: es la misma ciudad que la base.

### El workspace de Fly

La base de datos va a contener las tarjetas, saldos y datos de clientes de
todos los comercios del ecosistema. **No va en una cuenta personal.** Va en un
workspace a nombre de Sophos, con un segundo miembro desde el arranque.

Ojo con un detalle: los secretos de la app —entre ellos
`APPLE_PASS_ENCRYPTION_KEY`, sin la cual no se descifra ninguna clave de
firma— viven en Fly. Quien controla la cuenta de Fly controla la emisión de
pases de todos los comercios.

---

## 6. Orden sugerido

Ordenado por lo que desbloquea a lo demás, no por dificultad. Las dos wallets
ya están en producción; lo que queda es esto.

1. **Integrar ElMenu y Noctu.** Es lo único grande que queda del producto. El
   contrato está en `docs/integracion.md` y el SDK ya trae el flujo de
   activación: `upsertMerchant`, `configureProgram` y `createEmbedToken`.
   Requiere los repos de esos productos.

2. **Los dos textos legales**, antes de firmar el primer comercio. Ver más
   arriba.

3. **Mover la app de Fly a un workspace de Sophos**, con un segundo miembro.
   Cuantos más comercios haya, más cuesta.

4. **Automatizar la renovación de los certificados de Apple.** Tiene fecha: los
   primeros vencen alrededor de octubre de 2027. El provisioning ya sabe
   renovar; falta que el scheduler lo dispare para los que están por vencer.

5. **Verificar las geocercas y el tope de Google en teléfonos reales.** No
   bloquea nada, pero es lo único de las wallets que nadie vio funcionar.

6. **NFC, cuando y si Apple lo apruebe.** Depende del entitlement y de
   terminales certificados. No condiciona nada.

La lista completa de lo hecho y lo que falta para producción está en la sección
**Producción** del README; este orden es la misma lista, priorizada.
