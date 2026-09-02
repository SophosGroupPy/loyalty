-- El correo del cliente, tal como lo conoce ESTE comercio.
--
-- Va en `membership` y no en `person` por la misma razón que el nombre: el
-- registro compartido guarda solo la identidad verificada, y todo lo demás es
-- del comercio que lo recolectó. Que alguien le dé su correo a Don Julio no
-- significa que se lo esté dando al Bar Z.
--
-- `birthdate` ya existía en esta tabla.
ALTER TABLE membership ADD COLUMN IF NOT EXISTS email text;

COMMENT ON COLUMN membership.email IS
  'Correo tal como lo conoce este comercio. No se comparte entre comercios ni '
  'sube a `person`: el registro compartido es solo la identidad verificada.';
