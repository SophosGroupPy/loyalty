-- Deshacer un canje.
--
-- Hasta acá un canje era definitivo: los puntos salían del saldo y no había cómo
-- devolverlos. Alcanzaba mientras el canje se hacía de palabra, pero deja de
-- alcanzar apenas la caja lo aplica a un pedido — hay dos pasos (descontar los
-- puntos y tocar la venta) y el segundo puede fallar, o el pedido puede anularse
-- después.
--
-- La reversa no borra nada: el ledger es append-only, así que devolver los puntos
-- es un asiento nuevo. Esta marca existe para que revertir dos veces no regale
-- puntos dos veces.
ALTER TABLE redemption ADD COLUMN IF NOT EXISTS reversed_at timestamptz;

-- La reversa por pedido busca el canje vivo de ese pedido. Un pedido puede tener
-- un canje revertido y después otro válido, así que el índice deja fuera los ya
-- revertidos en vez de exigir unicidad sobre todos.
CREATE INDEX IF NOT EXISTS redemption_pedido_vivo_idx
    ON redemption (merchant_id, external_order_id)
 WHERE reversed_at IS NULL AND external_order_id IS NOT NULL;
