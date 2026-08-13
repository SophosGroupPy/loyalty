/**
 * Catálogo de textos de consentimiento.
 *
 * El id de versión vive **pegado al texto que etiqueta**, y el formulario manda
 * al servidor el id que efectivamente renderizó. Guardar `programa+identidad/v2`
 * sin poder reconstruir qué decía v2 convierte la columna `consent_version` en
 * una etiqueta que no apunta a nada: bajo la Ley 7593/2025 hay que poder mostrar
 * el texto exacto que la persona leyó, no un número de versión.
 *
 * **Cambiar un texto obliga a subir su versión.** Si se edita la redacción sin
 * tocar el id, quedan dos textos distintos guardados bajo el mismo rótulo y se
 * pierde el valor probatorio de todas las altas anteriores. Por eso el servidor
 * valida el id contra una lista conocida: si acá se sube a v3 y el servidor no
 * lo conoce, el alta falla de entrada en vez de guardar algo sin respaldo.
 *
 * Las versiones viejas no se borran nunca — hay personas dadas de alta bajo ellas.
 */

export interface TextoConsentimiento {
  id: string;
  /** `%s` se reemplaza por el nombre del comercio. */
  texto: string;
}

/** Consentimiento del programa del comercio. Obligatorio: sin esto no hay alta. */
export const PROGRAMA: TextoConsentimiento = {
  id: "programa/v1",
  texto:
    "Acepto participar del programa de fidelidad de %s y que guarde mis datos de contacto y consumo.",
};

/**
 * Consentimiento separado, opcional, para el registro compartido de Sophos.
 *
 * v2 amplía v1. La redacción de v1 —"para no tener que validarlo de nuevo en
 * otros comercios"— ataba el consentimiento a un solo fin: el alta de un toque.
 * Cualquier uso posterior habría necesitado volver a pedir consentimiento a toda
 * la base, y eso en la práctica no se recupera.
 *
 * v2 nombra también el segundo fin posible, sin prometerlo ("si lo lanza"). No
 * se puede consentir válidamente un fin sin especificar: un "acepto cualquier uso
 * futuro" no vale nada. Por eso se nombra concreto en vez de ampliar en vago.
 */
export const IDENTIDAD: TextoConsentimiento = {
  id: "identidad/v2",
  texto:
    "Acepto que Sophos Group conserve mi celular verificado para no tener que " +
    "validarlo de nuevo en otros comercios, y para mostrarme más adelante, si lo " +
    "lanza, un lugar donde ver juntos los programas en los que me di de alta.",
};

/**
 * Redacciones retiradas. Se conservan porque hay altas guardadas bajo estos ids
 * y hay que poder responder qué leyó esa persona.
 */
export const HISTORIAL: TextoConsentimiento[] = [
  {
    id: "identidad/v1",
    texto:
      "Acepto que Sophos Group conserve mi celular verificado para no tener que " +
      "validarlo de nuevo en otros comercios.",
  },
];
