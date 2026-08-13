-- ============================================================================
-- Fase 3 — webhooks hacia los productos
--
-- Es la mitad que faltaba del contrato de integración. Hasta acá los productos
-- le hablaban a loyalty; esto es loyalty hablándole a los productos.
--
-- El caso que justifica todo: cuando el cajero busca a un cliente, el POS tiene
-- que poder decirle "este cliente tiene un café gratis" **en ese momento**. Sin
-- webhooks, el producto tendría que preguntar por cada cliente en cada consulta.
-- ============================================================================

CREATE TABLE webhook_endpoint (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,

  url         text NOT NULL,
  -- Secreto con el que se firma cada entrega. El producto lo usa para verificar
  -- que el pedido salió de Sophos y no de cualquiera que conozca la URL.
  secret      text NOT NULL,

  -- Qué eventos quiere recibir. Vacío = todos.
  event_types text[] NOT NULL DEFAULT '{}',
  active      boolean NOT NULL DEFAULT true,

  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT webhook_one_url_per_product UNIQUE (product_id, url)
);

CREATE INDEX webhook_endpoint_by_product ON webhook_endpoint (product_id) WHERE active;

-- ----------------------------------------------------------------------------
-- Cada intento de entrega.
--
-- Se guarda la entrega, no solo el evento: si un producto estuvo caído una hora,
-- el comercio tiene derecho a saber qué avisos no llegaron y por qué. Sin esta
-- tabla, un webhook perdido es indistinguible de uno que nunca se generó.
-- ----------------------------------------------------------------------------
CREATE TABLE webhook_delivery (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoint(id) ON DELETE CASCADE,
  merchant_id uuid REFERENCES merchant(id) ON DELETE CASCADE,

  event_type  text NOT NULL,
  -- Id del evento, estable entre reintentos. El producto lo usa para deduplicar:
  -- un reintento tras un timeout puede llegar dos veces aunque el primero se
  -- haya procesado.
  event_id    uuid NOT NULL DEFAULT gen_random_uuid(),
  payload     jsonb NOT NULL,

  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'delivered', 'failed', 'exhausted')),
  attempts    integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),

  response_status integer,
  last_error  text,
  delivered_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Cola de entrega: pendientes vencidas, más viejas primero.
CREATE INDEX webhook_delivery_due ON webhook_delivery (next_attempt_at)
  WHERE status = 'pending';

CREATE INDEX webhook_delivery_by_endpoint
  ON webhook_delivery (endpoint_id, created_at DESC);

-- Para diagnosticar "¿por qué el POS no se enteró?" sobre un comercio puntual.
CREATE INDEX webhook_delivery_by_merchant
  ON webhook_delivery (merchant_id, created_at DESC);
