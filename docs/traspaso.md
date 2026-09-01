# Traspaso a desarrollo

**Al 2026-09-01.**

La arquitectura, las invariantes y el contrato de integración ya están escritos
en este repo. Este documento es la capa que no está ahí: el estado de los
trámites externos, las credenciales vivas, la especificación de Apple Wallet y
el orden en que conviene atacar lo que queda.

---

## 0. Leer primero, y no duplicar

El repo se documenta a sí mismo. Antes de tocar nada, tres lecturas en este
orden:

| Archivo | Qué contiene |
|---|---|
| [`README.md`](../README.md) | Arquitectura, las ocho invariantes que no se negocian, las decisiones de producto que no son evidentes desde el código y el listado completo de endpoints. **Es la fuente de verdad.** |
| [`docs/integracion.md`](integracion.md) | Cómo se integra un producto: credenciales, eventos, consultas del POS, webhooks y verificación de firma. |
| [`docs/google-wallet-verificacion.md`](google-wallet-verificacion.md) | Los valores que la documentación de Google define de forma contradictoria, y cuáles se verificaron contra la API real. |

Suite al momento de escribir esto: **197 casos en 12 archivos**, todos pasando.
Las invariantes del README están cubiertas por tests — si alguna se rompe, la
suite falla. Esa es la red de seguridad para tocar el motor de reglas o el
ledger.

---

## 1. Estado de los trámites externos

Todo esto cambió después de que se escribieron los documentos del repo.

| Frente | Estado | Detalle |
|---|---|---|
| Google Wallet API | **Aprobado** | Publishing access concedido el 2026-08-13. La cuenta salió de demo mode: cualquiera puede guardar una tarjeta y desaparece el prefijo `[TEST ONLY]`. |
| Apple Developer Program | **Activo** | Membresía de organización desde el 2026-09-01. App Store Connect habilitado. Vendedor: `SOPHOS GROUP E.A.S.` |
| Entitlement NFC de Apple | **En revisión** | Solicitado el 2026-09-01. Dos semanas o más, aprobación discrecional. Se declararon **0 terminales con Apple VAS desplegados**, que es la verdad. |
| Clase `don-julio` | **Publicada** | Era la clase de prueba de un restaurante ficticio. Al conceder el publishing access, Google publicó automáticamente toda clase en Active. Hoy figura `APPROVED`. |
| Infraestructura Railway | **Sin resolver** | Pospuesto desde el 2026-08-13. El proyecto creado por error en la cuenta personal ya fue borrado. |

### Sobre `don-julio`

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
D-U-N-S                955801894
Enrollment ID          PQLR6DGS4Y
```

### Variables de entorno

El detalle completo está en el README. Las que importan en producción:

| Variable | Nota |
|---|---|
| `DATABASE_URL` | Sin ella la API levanta PGlite en memoria y pierde todo al reiniciar. El servicio aborta el arranque si `NODE_ENV=production` y falta. |
| `JWT_SIGNING_KEY` | Tiene que ser estable. Si cambia, todos los productos integrados pierden sus tokens. |
| `ADMIN_API_KEY` | Acceso administrativo. |
| `GOOGLE_WALLET_SA_PRIVATE_KEY` | PEM. Acepta los `\n` escapados tal como vienen en el JSON de GCP. |

---

## 3. Apple Wallet — especificación de la fase 4

Esta es la parte que no está escrita en ningún lado del repo. Son decisiones
tomadas, no opciones a evaluar.

### Un Pass Type ID por comercio, no uno global

Es la decisión estructural de la fase y la más fácil de hacer mal, porque el
impulso natural es crear uno solo para todo el ecosistema.

Apple agrupa las tarjetas en la Wallet del cliente por `passTypeIdentifier` más
tipo de pase. Con un identificador compartido, las tarjetas de todos los bares
y restaurantes se le apilan juntas al cliente en una sola pila. El campo
`groupingIdentifier`, que serviría para separarlas, **solo aplica a
`eventTicket` y `boardingPass`** — no a las tarjetas de fidelidad.

El alta es automatizable por la App Store Connect API con
`POST /v1/passTypeIds`, así que dar de alta un comercio nuevo no tiene por qué
ser un trámite manual. Cada Pass Type ID necesita además su propio certificado
de firma.

### El branding va en el pase, no en un registro de Apple

Cada comercio lleva su propia marca en su tarjeta, y eso sale del `.pkpass`
mismo:

- `organizationName` — el nombre del comercio
- `logoText` — el texto junto al logo
- `logo.png` — el logo del comercio, en @1x, @2x y @3x
- `backgroundColor`, `foregroundColor`, `labelColor`

Se define al emitir, por comercio, y **no requiere ninguna aprobación de
Apple**. Sophos aparece solo en la cadena del certificado, nunca en la cara del
pase.

> **Descartado, para que no se vuelva a plantear.** Apple Business Register no
> es la palanca para esto. Registra la marca de la propia organización para
> Maps, Siri y algunas superficies de Wallet, y exige declarar que sos dueño de
> esa marca — o sea que Sophos no puede registrar las marcas de sus comercios.
> Si un comercio quiere presencia verificada en Apple, la tramita él con su
> propia organización.

### QR primero, NFC después

El v1 de Apple Wallet va con código de barras, igual que Google. El NFC depende
de tres cosas simultáneas: el entitlement de Apple (en revisión), terminales
certificados para Apple Pay VAS, y un software de caja que soporte los modos
«VAS Only» y «Payment and VAS».

En Paraguay el eslabón que no controlamos es el segundo: los comercios corren
POS en Windows y los pagos van por pinpads del adquirente, y todavía no está
identificado qué modelos son ni si soportan VAS. **No bloquear el v1 por esto.**

### Lo que hay que construir

- Generación y firma del `.pkpass` — el paquete, el manifiesto y la firma con
  el certificado del Pass Type ID de ese comercio.
- Web service de actualización con APNs, para que el saldo cambie en una
  tarjeta ya guardada sin reemitirla. Es el equivalente de lo que ya funciona
  en Google.
- Alta automatizada de Pass Type IDs y certificados por comercio.
- Reutilizar la cola de reconciliación existente: `GET /v1/passes/pending-sync`
  ya resuelve el desfasaje cuando la wallet no responde, y la invariante 6 del
  README aplica igual a Apple.

`packages/passes` hoy es solo Google. Conviene que Apple entre como un segundo
emisor detrás de la misma interfaz, no como una rama paralela.

---

## 4. Trampas ya pagadas

Cosas verificadas contra la API real que la documentación no dice, o dice mal.
Están acá para que nadie las vuelva a descubrir.

| Tema | Qué pasa |
|---|---|
| `notifyPreference` | El valor correcto es `NOTIFY_ON_UPDATE`, no `NOTIFY`. La referencia REST de Google está equivocada: la API rechaza `NOTIFY` con `INVALID_ARGUMENT`. Verificado el 2026-08-12. |
| Documentación de Google | Se contradice a sí misma en varios puntos. Ante un valor dudoso, probarlo contra la API antes que confiar en la referencia. |
| Aprobación de clases | Las clases se aprueban solas: vuelven `approved` pese a enviarse como `UNDER_REVIEW`. Dar de alta un comercio nuevo es instantáneo. |
| Actualización de saldo | Verificado contra la API real: el saldo se actualiza en una tarjeta ya guardada sin reemitirla. |
| Tope de notificaciones | 3 por tarjeta cada 24 h, regla de Google. Apple no publica una. Se controla del lado de Sophos porque el Issuer es único para todo el ecosistema: si un comercio abusa, el throttling afecta a todos. |
| `.railwayignore` | `railway up` sube el directorio **tal como está en disco**, no lo commiteado. El `.gitignore` no protege ahí — por eso existe el `.railwayignore` que excluye `.env.local`. |

Queda sin verificar lo que requiere un teléfono Android real: las geocercas y
el comportamiento efectivo del tope de notificaciones. El detalle de cómo
probarlo está en [`docs/google-wallet-verificacion.md`](google-wallet-verificacion.md).

---

## 5. Bloqueantes que no son código

Ninguno se resuelve programando. El primero bloquea el traspaso mismo; los
otros dos son más difíciles de revertir que cualquier decisión técnica de este
proyecto.

### El repo no tiene remoto

Al 2026-09-01 este repo tiene **26 commits y cero remotos configurados**. Todo
el módulo existe únicamente en la laptop de Diego: sin GitHub, sin backup, y
sin forma de entregárselo a nadie.

Esto bloquea el traspaso mismo, así que va antes que cualquier otra cosa. Un
disco que falla se lleva tres semanas de trabajo y las ocho invariantes con él.

### Los dos textos legales

Se escriben **antes de firmar el primer comercio**, y determinan si el
marketplace de consumidor queda posible o clausurado para siempre:

- **El contrato con comercios** — evitar la cláusula estándar «Sophos no usará
  los datos para ningún otro fin».
- **La segunda casilla de consentimiento del alta** — que no diga solo
  «reutilizar tu identidad en altas futuras», porque eso no cubriría un uso
  posterior de perfil de consumo.

Dejar la puerta abierta hoy cuesta cero: es solo cómo se redactan dos textos.
Cerrarla es irreversible en la práctica — renegociar con decenas de comercios
ya firmados no pasa, y volver a pedir consentimiento a una base ya dada de alta
tiene una tasa de respuesta miserable. Nada de esto se le promete al comercio
ni al cliente final; es solo no cerrarse la opción.

### El workspace de Railway

La base de datos va a contener las tarjetas, saldos y datos de clientes de
todos los comercios del ecosistema. **No va en una cuenta personal.** Va en un
workspace a nombre de Sophos, con un segundo miembro desde el arranque.

Transferir un proyecto después se puede y preserva volúmenes, variables,
historial y dominios, pero exige plan activo en las dos cuentas y una
invitación que hay que aceptar dentro de 24 h. Por eso conviene arrancar en el
lugar correcto en vez de mover después.

---

## 6. Orden sugerido

Ordenado por lo que desbloquea a lo demás, no por dificultad.

1. **Publicar el repo en un remoto.** Hoy no existe fuera de una máquina. Va a
   una organización de GitHub de Sophos, no a una cuenta personal — mismo
   criterio que Railway y por la misma razón.

2. **Resolver el workspace de Railway y desplegar.** Es lo único que hoy separa
   a un módulo construido y testeado de un módulo que existe. Todo lo demás se
   prueba mejor contra un entorno real.

3. **Emitir la primera tarjeta real en Google Wallet.** El publishing access ya
   está. La prueba de humo completa está en `docs/google-wallet-verificacion.md`.
   Aprovechar para archivar `don-julio` por API en la misma pasada.

4. **Cerrar la fase 2: alta con OTP y consola embebible.** Es lo que falta para
   que un comercio pueda operar solo, sin que nadie del equipo le cargue nada.

5. **Integrar ElMenu y Noctu.** Fase 3. El contrato está escrito en
   `docs/integracion.md`; no hay que diseñarlo de nuevo.

6. **Apple Wallet con QR.** La membresía ya está activa, así que no hay nada
   esperando. Seguir la especificación de la sección 3.

7. **NFC, cuando y si Apple lo apruebe.** Depende del entitlement y de
   terminales certificados. No condiciona nada de lo anterior.

En paralelo, la lista de **pendientes antes de producción** del README sigue
vigente: build compilado en vez de `tsx`, webhooks firmados con HMAC, el job de
vencimiento de puntos, ajustes manuales con PIN y audit log, rate limits por
comercio, y la auditoría periódica de saldos.
