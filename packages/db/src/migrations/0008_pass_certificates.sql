-- ============================================================================
-- Material de firma de Apple, por comercio
--
-- Cada comercio tiene su propio Pass Type ID —Apple apila las tarjetas por ese
-- identificador y `groupingIdentifier` no aplica a `storeCard`— y por lo tanto
-- su propio certificado y su propia clave privada. Con decenas de comercios eso
-- no entra en variables de entorno: son tres archivos por cada uno y se renuevan
-- cada año.
--
-- **La clave privada va cifrada, el certificado no.** El certificado es público:
-- viaja dentro de cada `.pkpass` que se emite. La clave privada es lo que
-- permite firmar en nombre del comercio, y un volcado de la base no puede
-- alcanzar para eso. Se cifra con AES-256-GCM usando una clave que vive en el
-- gestor de secretos y nunca en la base — si estuvieran las dos en el mismo
-- lugar, cifrar no serviría de nada.
--
-- El intermedio WWDR es uno solo para todos y no se guarda acá: viene por
-- configuración, porque es público, compartido y lo publica Apple.
-- ============================================================================

CREATE TABLE pass_certificate (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchant(id) ON DELETE CASCADE,

  pass_type_identifier text NOT NULL,

  -- PEM en claro. Es público.
  certificate_pem text NOT NULL,

  -- Clave privada cifrada con AES-256-GCM. Se guardan por separado el nonce y
  -- el tag de autenticación: sin el tag, un cifrado alterado se descifraría
  -- como basura en vez de fallar, y estaríamos firmando con una clave corrupta.
  private_key_ciphertext bytea NOT NULL,
  private_key_nonce      bytea NOT NULL,
  private_key_tag        bytea NOT NULL,

  -- Cuándo vence, para poder avisar antes de que se caiga. Los certificados de
  -- Pass Type ID duran un año: sin este dato la renovación se descubre el día
  -- que los pases de un comercio dejan de actualizarse.
  expires_at timestamptz NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  -- Un solo certificado activo por comercio. Renovar es reemplazar, no acumular.
  CONSTRAINT pass_certificate_one_per_merchant UNIQUE (merchant_id)
);

-- El web service resuelve por Pass Type ID, que es lo que manda el dispositivo.
CREATE UNIQUE INDEX pass_certificate_by_type
  ON pass_certificate (pass_type_identifier);

-- Para el aviso de vencimiento.
CREATE INDEX pass_certificate_expiring ON pass_certificate (expires_at);
