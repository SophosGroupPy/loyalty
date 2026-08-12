-- ============================================================================
-- Sophos Loyalty — esquema inicial (fase 1)
--
-- Tres separaciones que no se mezclan:
--   product   — el integrador (ElMenu, Noctu, FactuFast)
--   merchant  — el comercio real, dentro de un producto
--   person    — la identidad compartida del cliente final
--
-- No existe programa de fidelidad global: cada comercio tiene su `program` y
-- emite su propia `membership`. Los saldos no se cruzan en ningún punto.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Integradores del ecosistema. Cada uno tiene credenciales OAuth propias.
-- ----------------------------------------------------------------------------
CREATE TABLE product (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text NOT NULL UNIQUE,
  name               text NOT NULL,
  client_id          text NOT NULL UNIQUE,
  client_secret_hash text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- El comercio. `external_id` es su identificador dentro del producto de origen:
-- el mismo restaurante en ElMenu y en Noctu serían dos merchants distintos, que
-- es exactamente lo que queremos.
-- ----------------------------------------------------------------------------
CREATE TABLE merchant (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   uuid NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
  external_id  text NOT NULL,
  slug         text NOT NULL UNIQUE,
  legal_name   text NOT NULL,
  display_name text NOT NULL,
  timezone     text NOT NULL DEFAULT 'America/Asuncion',
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT merchant_unique_per_product UNIQUE (product_id, external_id)
);

-- ----------------------------------------------------------------------------
-- El programa de fidelidad. La mecánica vive en `config` como jsonb y la
-- interpreta @sophos/rules — no hay código por cliente.
-- ----------------------------------------------------------------------------
CREATE TABLE program (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchant(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('points', 'stamps')),
  config      jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'paused')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Un solo programa activo por comercio en el v1. El índice parcial lo garantiza
-- sin impedir que queden programas viejos pausados como historial.
CREATE UNIQUE INDEX program_one_active_per_merchant
  ON program (merchant_id) WHERE status = 'active';

-- ----------------------------------------------------------------------------
-- Identidad compartida. Es LO ÚNICO global del sistema.
--
-- Guarda solo lo que la persona verificó una vez. El perfil que administra cada
-- comercio (nombre como él lo conoce, notas, etiquetas) vive en `membership`,
-- para que una edición en un bar no toque la ficha del restaurante.
-- ----------------------------------------------------------------------------
CREATE TABLE person (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164        text NOT NULL UNIQUE,
  phone_verified_at timestamptz,
  first_name        text,
  consent_version   text NOT NULL,
  consented_at      timestamptz NOT NULL DEFAULT now(),
  -- Borrado global a pedido del titular (Ley 7593/2025). Al marcarse, cascadea
  -- a todas sus membresías: es el único derecho que atraviesa comercios.
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- LA TARJETA. Una por persona y por programa.
--
-- `merchant_id` está desnormalizado a propósito: toda consulta del sistema
-- filtra por comercio, y tenerlo acá permite que el guard de aislamiento sea
-- una condición directa en vez de un join que alguien puede olvidar.
-- ----------------------------------------------------------------------------
CREATE TABLE membership (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     uuid NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  program_id    uuid NOT NULL REFERENCES program(id) ON DELETE CASCADE,
  merchant_id   uuid NOT NULL REFERENCES merchant(id) ON DELETE CASCADE,

  serial_number text NOT NULL UNIQUE,

  -- Perfil administrado por ESTE comercio, aislado del resto.
  display_name  text,
  notes         text,
  tags          text[] NOT NULL DEFAULT '{}',
  birthdate     date,

  -- Proyección del ledger. Solo lo escribe el servicio de ledger, en la misma
  -- transacción que el asiento. Nunca se muta por fuera.
  balance       integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  tier          text,

  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'opted_out', 'deleted')),
  issued_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT membership_one_per_program UNIQUE (person_id, program_id)
);

CREATE INDEX membership_by_merchant ON membership (merchant_id, status);
CREATE INDEX membership_by_person ON membership (person_id);

-- ----------------------------------------------------------------------------
-- Ingesta de eventos de negocio. La unicidad de (product_id, idempotency_key)
-- es lo que hace seguro que un POS con mala señal reintente.
-- ----------------------------------------------------------------------------
CREATE TABLE event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      uuid NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
  merchant_id     uuid NOT NULL REFERENCES merchant(id) ON DELETE CASCADE,
  membership_id   uuid REFERENCES membership(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  type            text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}',
  occurred_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  -- Traza de la evaluación, incluso cuando no generó asiento (por ejemplo
  -- cuando el tope diario lo dejó en cero). Sin esto no se puede explicar por
  -- qué un consumo no sumó puntos, que es la primera pregunta del comercio.
  result          jsonb,

  CONSTRAINT event_idempotent_per_product UNIQUE (product_id, idempotency_key)
);

CREATE INDEX event_unprocessed ON event (received_at) WHERE processed_at IS NULL;

-- ----------------------------------------------------------------------------
-- Catálogo de beneficios del programa.
-- ----------------------------------------------------------------------------
CREATE TABLE reward (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id  uuid NOT NULL REFERENCES program(id) ON DELETE CASCADE,
  merchant_id uuid NOT NULL REFERENCES merchant(id) ON DELETE CASCADE,
  name        text NOT NULL,
  cost        integer NOT NULL CHECK (cost > 0),
  terms       text,
  status      text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX reward_by_program ON reward (program_id, status);

-- ----------------------------------------------------------------------------
-- EL LEDGER. Append-only, y la fuente de verdad del saldo.
--
-- El saldo de `membership` es una proyección de esta tabla. Sin un libro de
-- asientos inmutable no hay forma de auditar ni de resolver una disputa con un
-- comercio sobre los puntos de un cliente.
-- ----------------------------------------------------------------------------
CREATE TABLE ledger_entry (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id   uuid NOT NULL REFERENCES membership(id) ON DELETE CASCADE,
  merchant_id     uuid NOT NULL REFERENCES merchant(id) ON DELETE CASCADE,

  kind            text NOT NULL
                    CHECK (kind IN ('earn', 'redeem', 'adjust', 'expire')),
  -- Positivo suma, negativo resta. Cero no se registra: un evento que no movió
  -- el saldo deja su rastro en `event.result`, no acá.
  amount          integer NOT NULL CHECK (amount <> 0),
  balance_after   integer NOT NULL CHECK (balance_after >= 0),

  -- Día de negocio al que se imputa, según el huso y el corte del programa.
  -- Es la clave del tope diario: para un boliche con corte a las 6, la
  -- madrugada del sábado cuenta como parte del viernes.
  business_day    date NOT NULL,

  source_event_id uuid REFERENCES event(id) ON DELETE SET NULL,
  reason          text,
  trace           jsonb,
  -- 'system' para lo automático, 'staff:<id>' para ajustes manuales.
  actor           text NOT NULL DEFAULT 'system',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_by_membership_day
  ON ledger_entry (membership_id, business_day) WHERE kind = 'earn';
CREATE INDEX ledger_by_membership
  ON ledger_entry (membership_id, created_at DESC);

-- Un asiento por evento: segunda línea de defensa de la idempotencia, por
-- debajo de la unicidad de `event`. Si la lógica de aplicación falla, la base
-- igual rechaza el asiento duplicado.
CREATE UNIQUE INDEX ledger_one_earn_per_event
  ON ledger_entry (source_event_id) WHERE source_event_id IS NOT NULL;

-- El append-only se hace cumplir en la base, no por convención. Un UPDATE
-- silencioso sobre un asiento destruiría la auditoría sin dejar rastro.
CREATE OR REPLACE FUNCTION ledger_entry_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'ledger_entry es append-only: % rechazado. Para revertir, insertá un asiento de ajuste.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entry_immutable
  BEFORE UPDATE OR DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_append_only();

-- ----------------------------------------------------------------------------
-- Canjes. Siempre atados a un asiento del ledger: no hay canje sin movimiento.
-- ----------------------------------------------------------------------------
CREATE TABLE redemption (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id   uuid NOT NULL REFERENCES membership(id) ON DELETE CASCADE,
  merchant_id     uuid NOT NULL REFERENCES merchant(id) ON DELETE CASCADE,
  reward_id       uuid NOT NULL REFERENCES reward(id) ON DELETE RESTRICT,
  ledger_entry_id uuid NOT NULL UNIQUE REFERENCES ledger_entry(id) ON DELETE RESTRICT,
  redeemed_by     text NOT NULL,
  redeemed_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX redemption_by_membership ON redemption (membership_id, redeemed_at DESC);
