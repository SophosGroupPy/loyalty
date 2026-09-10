-- Novedad visible por tarjeta, y el motivo honesto de "no hay dónde entregar".
--
-- Apple no recibe texto: el aviso visible viaja como el valor nuevo del campo de
-- novedades del pase, que lleva `changeMessage`. Para que el pase servido lo
-- muestre hay que guardarlo por tarjeta —el diseño es del comercio, pero la
-- novedad es de cada cliente—, así que vive en `pass_instance`, no en el diseño.
ALTER TABLE pass_instance ADD COLUMN IF NOT EXISTS news text;

-- Un aviso a una tarjeta sin pase instalado en ninguna wallet no es un fallo de
-- envío: es que no hay dónde entregarlo. Distinguirlo de `send_failed` es lo que
-- le permite al comercio leer "esta persona no agregó la tarjeta" en vez de
-- "algo se rompió", que son cosas muy distintas y llevan a decisiones distintas.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_suppressed_reason_check;
ALTER TABLE notification ADD CONSTRAINT notification_suppressed_reason_check
  CHECK (suppressed_reason IN (
    'coalesced', 'budget_exhausted', 'opted_out',
    'card_inactive', 'send_failed', 'no_installed_pass'));

-- Backfill de las tarjetas de Apple YA instaladas.
--
-- Hasta ahora nada creaba la fila de pase de Apple, así que ninguna tarjeta
-- instalada tiene una. El arreglo la crea al registrar el dispositivo, pero un
-- iPhone que ya tiene el pase no vuelve a registrarse solo por un deploy: sin
-- este backfill, esas tarjetas seguirían sin actualizarse ni recibir avisos hasta
-- que el cliente la re-agregue. Los registros de dispositivo que ya existen son
-- exactamente las tarjetas instaladas, así que de ahí salen las filas que faltan.
INSERT INTO pass_instance (membership_id, merchant_id, platform, external_id, state)
SELECT DISTINCT r.membership_id, m.merchant_id, 'apple', r.serial_number, 'active'
FROM apple_device_registration r
JOIN membership m ON m.id = r.membership_id
ON CONFLICT (membership_id, platform) DO NOTHING;
