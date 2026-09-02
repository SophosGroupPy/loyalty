-- ============================================================================
-- Coordinación de los trabajos periódicos
--
-- Un renglón por trabajo, con cuándo corrió por última vez. Sirve para dos
-- cosas a la vez:
--
-- 1. **Que no corran dos veces.** Durante un deploy conviven dos máquinas por
--    unos segundos, y sin esto las dos despacharían la misma cola. El reclamo
--    es un UPDATE condicional: quien lo gana devuelve fila, el otro no.
--
-- 2. **Saber si el sistema está vivo.** Un trabajo que dejó de correr no avisa;
--    se nota recién cuando alguien pregunta por qué no llegó una notificación.
--    Con esta tabla, el back-office puede mostrarlo.
--
-- No crece: es un renglón fijo por trabajo, actualizado en el lugar.
-- ============================================================================

CREATE TABLE job_run (
  name        text PRIMARY KEY,
  last_run_at timestamptz NOT NULL DEFAULT to_timestamp(0),
  -- Qué máquina lo tomó la última vez. Para diagnosticar sin revisar logs.
  last_host   text,
  -- Resumen de la última corrida, tal como lo devolvió el trabajo.
  last_result jsonb
);
