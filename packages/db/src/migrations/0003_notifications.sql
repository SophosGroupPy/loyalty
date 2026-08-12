-- ============================================================================
-- Fase 2 — despachador de notificaciones
--
-- No es una cola de "pasó algo → mandá". Google acepta como máximo 3
-- notificaciones por pase cada 24 horas y WhatsApp cobra por mensaje, así que
-- cada envío compite por un recurso escaso y hay que decidir cuál gana.
--
-- El cupo se controla del lado de Sophos y no se delega en el rechazo de
-- Google: el Issuer es único para todo el ecosistema, así que si un comercio
-- abusa el throttling cae sobre TODOS los comercios a la vez.
-- ============================================================================

-- Baja de notificaciones por canal, independiente de seguir en el programa.
-- Darse de baja de los avisos no es lo mismo que darse de baja de la tarjeta.
ALTER TABLE membership ADD COLUMN notification_optout text[] NOT NULL DEFAULT '{}';

-- ----------------------------------------------------------------------------
-- Campaña: lo único que escribe el comercio.
--
-- Los contadores existen para poder reportar **entrega parcial**. Como el cupo
-- es por tarjeta, una campaña a 500 clientes no llega a 500: a quien ya consumió
-- varias veces ese día se le llenó el cupo y queda afuera. Mostrar un "enviado"
-- plano haría que el comercio tome decisiones sobre un número falso.
-- ----------------------------------------------------------------------------
CREATE TABLE campaign (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchant(id) ON DELETE CASCADE,
  header      text NOT NULL,
  body        text NOT NULL,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX campaign_by_merchant ON campaign (merchant_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- La notificación.
--
-- Guarda una INTENCIÓN, no un texto: el cuerpo de los avisos transaccionales se
-- arma al despachar, con el saldo vivo. Así, si tres consumos se agrupan en uno
-- solo, el cliente recibe el saldo final y no el de la primera compra. Las
-- campañas son la excepción, porque el texto lo escribió el comercio.
-- ----------------------------------------------------------------------------
CREATE TABLE notification (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL REFERENCES membership(id) ON DELETE CASCADE,
  merchant_id   uuid NOT NULL REFERENCES merchant(id) ON DELETE CASCADE,

  channel       text NOT NULL CHECK (channel IN ('wallet', 'whatsapp', 'webpush')),
  kind          text NOT NULL CHECK (kind IN (
                  'balance_changed', 'points_expiring', 'reward_unlocked',
                  'tier_changed', 'campaign')),
  -- Menor gana. Ver PRIORITY en el despachador.
  priority      integer NOT NULL,

  -- Clave de agrupación. Dos avisos con la misma clave sobre la misma tarjeta
  -- no se mandan dos veces: el segundo se marca 'coalesced'.
  dedupe_key    text NOT NULL,

  -- Solo lo usan las campañas; el resto se arma al despachar.
  header        text,
  body          text,
  campaign_id   uuid REFERENCES campaign(id) ON DELETE CASCADE,

  scheduled_for timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  suppressed_reason text CHECK (suppressed_reason IN (
                  'coalesced', 'budget_exhausted', 'opted_out',
                  'card_inactive', 'send_failed')),
  -- Qué notificación absorbió a ésta, cuando se agrupó.
  superseded_by uuid REFERENCES notification(id) ON DELETE SET NULL,
  last_error    text,

  created_at    timestamptz NOT NULL DEFAULT now()
);

-- El corazón del agrupamiento: la base garantiza que no haya dos avisos
-- pendientes con la misma clave para la misma tarjeta. Resolverlo con un
-- SELECT-y-después-INSERT dejaría una carrera abierta entre dos consumos
-- simultáneos, que es justo el caso que hay que agrupar.
CREATE UNIQUE INDEX notification_one_pending_per_key
  ON notification (membership_id, channel, dedupe_key)
  WHERE sent_at IS NULL AND suppressed_reason IS NULL;

-- Cola de despacho: pendientes vencidas, por prioridad.
CREATE INDEX notification_due
  ON notification (priority, scheduled_for)
  WHERE sent_at IS NULL AND suppressed_reason IS NULL;

-- Ventana móvil de 24 h para el cupo por tarjeta.
CREATE INDEX notification_sent_window
  ON notification (membership_id, channel, sent_at)
  WHERE sent_at IS NOT NULL;

CREATE INDEX notification_by_campaign ON notification (campaign_id);
