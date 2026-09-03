-- ----------------------------------------------------------------------------
-- Reintentos del alta de material de firma de Apple.
--
-- El alta pasó de ser un comando que alguien corría por comercio a un trabajo
-- periódico. Eso lo vuelve automático, pero también significa que un comercio
-- que Apple rechaza se reintentaría cada minuto para siempre — contra una API
-- externa, con rate limit, y sin que nadie se entere de por qué falla.
--
-- Esta tabla es lo que evita las dos cosas: guarda el intento, el motivo del
-- rechazo, y cuándo volver a probar con espera creciente.
--
-- Solo tiene filas mientras algo está pendiente o fallando. Cuando el
-- certificado se emite, la fila se borra: el estado de "ya está" vive en
-- `pass_certificate`, y tener dos lugares que digan lo mismo es tener dos
-- lugares que pueden discrepar.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pass_provision_attempt (
  merchant_id     uuid PRIMARY KEY REFERENCES merchant(id) ON DELETE CASCADE,
  attempts        integer NOT NULL DEFAULT 0,
  -- El detalle que devolvió Apple. Es lo único que distingue "el nombre tiene
  -- un acento" de "no tenés permiso en la cuenta".
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- El barrido pregunta siempre lo mismo: a quién le toca ahora.
CREATE INDEX IF NOT EXISTS pass_provision_attempt_due
  ON pass_provision_attempt (next_attempt_at);
