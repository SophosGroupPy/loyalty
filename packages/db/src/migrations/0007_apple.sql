-- ============================================================================
-- Registro de dispositivos de Apple
--
-- Apple no permite mandarle contenido a un pase. El flujo es al revés: cuando
-- el cliente agrega la tarjeta, el iPhone se registra contra nuestro web
-- service dejando un push token; después, para avisar que algo cambió, se manda
-- un push **con payload vacío** y el propio teléfono vuelve a pedir el pase
-- entero. Sin esta tabla no hay a quién avisarle, y la tarjeta queda congelada
-- en el saldo que tenía al guardarse.
--
-- Google no necesita nada de esto: se hace PATCH al objeto y listo. La asimetría
-- es de las plataformas, no del diseño.
--
-- Un mismo pase puede estar en varios dispositivos de la misma persona (iPhone
-- y Apple Watch cuentan por separado), y un mismo dispositivo lleva muchos
-- pases. De ahí que la clave sea la terna completa.
-- ============================================================================

CREATE TABLE apple_device_registration (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificador opaco que manda el dispositivo. No es el UDID ni nada que
  -- identifique al equipo fuera de este pase.
  device_library_identifier text NOT NULL,
  pass_type_identifier      text NOT NULL,
  serial_number             text NOT NULL,

  -- Token de APNs. Cambia solo, y el dispositivo re-registra cuando pasa.
  push_token                text NOT NULL,

  membership_id uuid NOT NULL REFERENCES membership(id) ON DELETE CASCADE,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT apple_registration_unique
    UNIQUE (device_library_identifier, pass_type_identifier, serial_number)
);

-- Para el push: a qué dispositivos hay que avisarle de este pase.
CREATE INDEX apple_registration_by_pass
  ON apple_device_registration (pass_type_identifier, serial_number);

-- Para el listado que pide el dispositivo al despertar: qué pases suyos
-- cambiaron desde la última vez.
CREATE INDEX apple_registration_by_device
  ON apple_device_registration (device_library_identifier, pass_type_identifier);

-- ----------------------------------------------------------------------------
-- Cuándo cambió el contenido del pase
--
-- `last_synced_at` dice cuándo se logró empujar el cambio a la plataforma, que
-- es otra cosa: puede haber fallado. Lo que Apple pregunta con
-- `passesUpdatedSince` es cuándo cambió el pase, con independencia de si el
-- envío salió bien. Mezclar las dos hace que un push fallido borre el pase de
-- la lista de pendientes, que es exactamente al revés de lo que hay que hacer.
--
-- **Precisión de milisegundos, y es una decisión.** La marca que Apple lleva
-- entre consultas la generamos nosotros desde `Date`, que solo tiene
-- milisegundos. Con la precisión por defecto de Postgres —microsegundos— un
-- valor `.729456` sería siempre mayor que la marca `.729` que devolvimos, y el
-- dispositivo volvería a pedir el pase en cada despertar, para siempre. No
-- falla en desarrollo porque PGlite guarda milisegundos: fallaría recién contra
-- Postgres de verdad, en producción, y como desperdicio de batería y de
-- requests, no como error.
-- ----------------------------------------------------------------------------
ALTER TABLE pass_instance
  ADD COLUMN content_updated_at timestamptz(3) NOT NULL DEFAULT now();

CREATE INDEX pass_by_content_updated
  ON pass_instance (membership_id, content_updated_at);
