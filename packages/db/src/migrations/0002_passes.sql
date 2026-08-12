-- ============================================================================
-- Fase 2 — tarjetas en wallet
--
-- El diseño de la tarjeta y las geocercas son del comercio; `pass_instance` es
-- el estado del pase emitido en cada plataforma.
-- ============================================================================

-- Diseño de la tarjeta, con la forma de `CardDesign` de @sophos/passes.
--
-- `newsLabel` se guarda desde ahora aunque Google no lo use: en Apple es el
-- único vehículo posible para las notificaciones, y agregar el campo después
-- obliga a reemitir todos los pases.
ALTER TABLE merchant ADD COLUMN design jsonb;

-- ----------------------------------------------------------------------------
-- Geocercas. Es el canal de notificación más barato: lo dispara el sistema
-- operativo con el texto ya embebido en el pase, sin consumir el cupo diario.
--
-- Apple admite 10 por pase. Google no documenta tope pero fija el radio él
-- mismo, así que no hay `maxDistance` configurable de ese lado.
-- ----------------------------------------------------------------------------
CREATE TABLE merchant_location (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchant(id) ON DELETE CASCADE,
  label       text NOT NULL,
  latitude    double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude   double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  -- Texto que aparece en la pantalla bloqueada al acercarse. Solo lo usa Apple.
  relevant_text text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX merchant_location_by_merchant ON merchant_location (merchant_id);

-- ----------------------------------------------------------------------------
-- El pase emitido, por plataforma.
--
-- `last_synced_balance` es lo que hace reconciliable el sistema: si difiere del
-- saldo de la membresía, el pase quedó desactualizado —típicamente porque
-- Google estaba caído cuando se acumuló— y hay que reintentar.
--
-- La sincronización es best-effort a propósito: **una caída de Google no puede
-- hacer fallar una acumulación**. El ledger es la verdad; el pase es una vista.
-- ----------------------------------------------------------------------------
CREATE TABLE pass_instance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL REFERENCES membership(id) ON DELETE CASCADE,
  merchant_id   uuid NOT NULL REFERENCES merchant(id) ON DELETE CASCADE,

  platform      text NOT NULL CHECK (platform IN ('google', 'apple', 'web')),
  -- Identificador del pase en la plataforma: el object id en Google.
  external_id   text NOT NULL,

  state         text NOT NULL DEFAULT 'active'
                  CHECK (state IN ('active', 'revoked')),

  last_synced_balance integer,
  last_synced_at      timestamptz,
  -- Último error de sincronización, para diagnosticar sin revisar logs.
  last_error          text,

  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pass_one_per_platform UNIQUE (membership_id, platform)
);

CREATE INDEX pass_by_merchant ON pass_instance (merchant_id, platform);

-- Pases cuyo saldo no coincide con el de la tarjeta: la cola de reconciliación.
CREATE INDEX pass_pending_sync ON pass_instance (last_synced_at)
  WHERE state = 'active';
