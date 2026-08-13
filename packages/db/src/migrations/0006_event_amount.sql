-- ============================================================================
-- El monto de la transacción, persistido
--
-- Hasta acá el monto llegaba en el evento, se usaba para calcular los puntos y
-- se descartaba: solo quedaba el resultado en puntos. Eso hacía imposible
-- responder "¿cuánto gasta este cliente?" desde loyalty, y empujaba a la idea
-- de importar el CRM del producto — que es justo lo que NO hay que hacer.
--
-- Guardándolo, loyalty deriva de sus propios datos las visitas, el gasto total,
-- el ticket promedio y la última visita, **solo de los clientes que consintieron
-- el programa**. Sin sincronizar bases, sin duplicar el CRM, y sin tocar datos
-- de gente que nunca se sumó.
--
-- En la unidad mínima de la moneda: para guaraníes, el guaraní entero.
-- ============================================================================

ALTER TABLE event ADD COLUMN amount integer CHECK (amount IS NULL OR amount >= 0);

-- Para el historial por cliente: sus consumos, del más reciente al más viejo.
CREATE INDEX event_by_membership
  ON event (membership_id, occurred_at DESC)
  WHERE membership_id IS NOT NULL;
