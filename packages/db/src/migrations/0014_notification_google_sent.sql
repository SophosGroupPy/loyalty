-- El cupo diario es de Google, no de Apple.
--
-- Hasta acá el tope de 3/24 h se contaba sobre `sent_at`, que marca "este aviso
-- salió por alguna wallet". Eso hacía que un aviso entregado SOLO por Apple
-- gastara cupo de Google —y que a un cliente de iPhone, donde la plataforma no
-- impone ningún tope, se le cortaran los avisos por una regla que no lo alcanza.
--
-- `google_sent_at` marca la entrega efectiva a Google, que es lo único que el
-- cupo tiene que proteger: el Issuer es compartido por todos los comercios, y si
-- Google throttlea, el daño es de todos.
ALTER TABLE notification ADD COLUMN IF NOT EXISTS google_sent_at timestamptz;

-- Backfill conservador: de lo ya enviado no sabemos qué wallet lo recibió, así
-- que se asume que Google sí. Al revés —asumir que no— regalaría cupo hoy mismo
-- y podría empujar al Issuer contra el límite real de Google.
UPDATE notification
   SET google_sent_at = sent_at
 WHERE sent_at IS NOT NULL
   AND google_sent_at IS NULL;

-- El cupo se consulta por (tarjeta, ventana de 24 h) en cada despacho.
CREATE INDEX IF NOT EXISTS notification_google_budget_idx
    ON notification (membership_id, google_sent_at)
 WHERE google_sent_at IS NOT NULL;
