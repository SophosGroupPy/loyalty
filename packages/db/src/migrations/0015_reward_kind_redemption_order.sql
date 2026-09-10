-- Beneficios canjeables: el beneficio sabe qué es y cómo se entrega, y el canje
-- sabe dónde se usó.
--
-- Hasta acá un `reward` era un nombre y un costo en puntos. Alcanzaba mientras el
-- canje se hacía de palabra, pero no para que la caja lo aplique: "Café gratis"
-- no le dice al sistema si hay que agregar un producto, descontar un porcentaje o
-- no tocar la venta.

-- ---------------------------------------------------------------------------
-- Fase 1 — qué es el beneficio, y cómo se entrega
-- ---------------------------------------------------------------------------

-- Son dos preguntas independientes. Un mismo "Café gratis" puede descontarse del
-- ticket en un local y entregarse aparte en otro, y esa decisión es del comercio,
-- no del tipo de beneficio.
ALTER TABLE reward ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'free_item';
ALTER TABLE reward ADD COLUMN IF NOT EXISTS value integer;
ALTER TABLE reward ADD COLUMN IF NOT EXISTS external_product_id text;
ALTER TABLE reward ADD COLUMN IF NOT EXISTS entrega text NOT NULL DEFAULT 'aparte';

-- Los defaults describen lo que los beneficios existentes ya son: un producto sin
-- vincular que alguien entrega a mano. Nada cambia de comportamiento al migrar.

ALTER TABLE reward DROP CONSTRAINT IF EXISTS reward_kind_check;
ALTER TABLE reward ADD CONSTRAINT reward_kind_check
  CHECK (kind IN ('free_item', 'percentage', 'fixed'));

ALTER TABLE reward DROP CONSTRAINT IF EXISTS reward_entrega_check;
ALTER TABLE reward ADD CONSTRAINT reward_entrega_check
  CHECK (entrega IN ('aparte', 'ticket'));

-- `value` solo tiene sentido en los descuentos, y con rango: un 0 % no es un
-- beneficio y un 150 % regala plata. Que lo diga la base evita depender de que
-- todas las vías de escritura validen igual.
ALTER TABLE reward DROP CONSTRAINT IF EXISTS reward_value_check;
ALTER TABLE reward ADD CONSTRAINT reward_value_check CHECK (
     (kind = 'free_item' AND value IS NULL)
  OR (kind = 'percentage' AND value BETWEEN 1 AND 100)
  OR (kind = 'fixed'      AND value > 0)
);

-- Para descontar un producto del ticket hay que saber CUÁL producto: la caja
-- necesita el id para agregar la línea. Entregado aparte no hace falta — ahí el
-- beneficio es un texto que alguien lee y cumple.
ALTER TABLE reward DROP CONSTRAINT IF EXISTS reward_ticket_producto_check;
ALTER TABLE reward ADD CONSTRAINT reward_ticket_producto_check CHECK (
  NOT (entrega = 'ticket' AND kind = 'free_item' AND external_product_id IS NULL)
);

-- ---------------------------------------------------------------------------
-- Fase 2 — dónde se usó el canje
-- ---------------------------------------------------------------------------

-- Sin esto el comercio ve que se canjearon 300 puntos pero no contra qué venta,
-- y no puede cruzar lo canjeado con lo vendido. Quedan nullable: un canje
-- entregado aparte puede no tener pedido, y uno sin descuento no tiene monto.
ALTER TABLE redemption ADD COLUMN IF NOT EXISTS external_order_id text;
ALTER TABLE redemption ADD COLUMN IF NOT EXISTS discount_amount integer;

ALTER TABLE redemption DROP CONSTRAINT IF EXISTS redemption_discount_check;
ALTER TABLE redemption ADD CONSTRAINT redemption_discount_check
  CHECK (discount_amount IS NULL OR discount_amount >= 0);

-- El historial de canjes se lee por comercio y por fecha.
CREATE INDEX IF NOT EXISTS redemption_merchant_fecha_idx
    ON redemption (merchant_id, redeemed_at DESC);
