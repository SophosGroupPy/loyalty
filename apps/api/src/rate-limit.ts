/**
 * Límite de tasa por comercio.
 *
 * Protege dos cosas distintas. La primera es la obvia: un bucle desbocado en el
 * POS de un producto no puede consumir la capacidad de todo el ecosistema, y
 * como el Issuer de Google y la cuenta de Apple son **una sola para todos los
 * comercios**, el daño de un integrador que se descontrola lo pagan los demás.
 *
 * La segunda es antifraude: acumular mil veces en un minuto sobre la misma
 * tarjeta no es un cliente, es alguien probando. Los topes por día y por evento
 * del motor de reglas acotan cuántos puntos se llevan; esto acota cuántas veces
 * puede intentarlo.
 *
 * **Vive en memoria del proceso, y eso importa.** Con dos instancias, el límite
 * efectivo es el doble del configurado. Es aceptable mientras haya una sola
 * —la protección sigue valiendo, solo que menos fina— pero al escalar
 * horizontalmente hay que moverlo a Postgres o Redis. Se elige esto antes que
 * una tabla porque un contador en la base agrega una escritura a cada
 * acumulación, que es justamente el camino que hay que mantener barato.
 */

export interface RateLimitOptions {
  /** Cuántas peticiones se permiten en la ventana. */
  max: number;
  /** Largo de la ventana, en milisegundos. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Cuántas quedan en la ventana actual. */
  remaining: number;
  /** Segundos hasta que se libere lugar. Solo cuando `allowed` es `false`. */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string): RateLimitResult;
  /** Libera memoria de las ventanas ya vencidas. */
  sweep(): void;
}

/**
 * Ventana deslizante por marcas de tiempo.
 *
 * Se guardan los instantes de cada petición en vez de un contador con reinicio
 * fijo. Un contador que se reinicia cada minuto permite el doble del límite a
 * caballo del reinicio: 100 al final de un minuto y 100 al principio del
 * siguiente son 200 en dos segundos.
 */
export function createRateLimiter(
  options: RateLimitOptions,
  now: () => number = Date.now,
): RateLimiter {
  const hits = new Map<string, number[]>();

  function vigentes(key: string, ahora: number): number[] {
    const desde = ahora - options.windowMs;
    const previas = hits.get(key) ?? [];
    const dentro = previas.filter((t) => t > desde);

    if (dentro.length === 0) hits.delete(key);
    else hits.set(key, dentro);

    return dentro;
  }

  return {
    check(key) {
      const ahora = now();
      const dentro = vigentes(key, ahora);

      if (dentro.length >= options.max) {
        const masVieja = dentro[0]!;
        return {
          allowed: false,
          remaining: 0,
          // Cuándo sale de la ventana la más vieja: es el momento exacto en que
          // se libera lugar. Redondeado hacia arriba para no invitar a
          // reintentar un instante antes de tiempo.
          retryAfterSeconds: Math.max(1, Math.ceil((masVieja + options.windowMs - ahora) / 1000)),
        };
      }

      dentro.push(ahora);
      hits.set(key, dentro);

      return { allowed: true, remaining: options.max - dentro.length, retryAfterSeconds: 0 };
    },

    sweep() {
      const ahora = now();
      for (const key of [...hits.keys()]) vigentes(key, ahora);
    },
  };
}
