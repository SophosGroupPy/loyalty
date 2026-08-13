-- ============================================================================
-- Fase 2 — verificación del celular por OTP
--
-- Es la pieza de mayor riesgo del sistema. El celular verificado es la clave de
-- la identidad compartida entre comercios, así que quien logre verificar un
-- número ajeno no se hace pasar por esa persona en un solo comercio: se la
-- apropia en todo el ecosistema.
--
-- De ahí que el código se guarde hasheado, con vencimiento, tope de intentos y
-- límite de envíos por número.
-- ============================================================================

CREATE TABLE otp_challenge (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164  text NOT NULL,

  -- El desafío está atado al comercio: un código pedido para un bar no sirve
  -- para darse de alta en un restaurante.
  merchant_id uuid NOT NULL REFERENCES merchant(id) ON DELETE CASCADE,

  -- Nunca el código en claro. Si la base se filtra, los códigos vigentes no se
  -- pueden usar.
  code_hash   text NOT NULL,

  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  -- Se marca al usarse o al agotar los intentos. Un desafío consumido no
  -- vuelve a servir aunque no haya vencido.
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Sirve para dos cosas: encontrar el desafío vigente y contar los envíos
-- recientes de un número para el rate limit.
CREATE INDEX otp_by_phone ON otp_challenge (phone_e164, created_at DESC);

-- Un solo desafío vigente por número y comercio. Pedir un código nuevo invalida
-- el anterior, así no quedan varios códigos válidos a la vez multiplicando la
-- superficie de adivinación.
CREATE UNIQUE INDEX otp_one_live_per_phone_merchant
  ON otp_challenge (phone_e164, merchant_id)
  WHERE consumed_at IS NULL;
