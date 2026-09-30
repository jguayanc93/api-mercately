import { env, proveedorConfigurado } from '../config/env.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ modulo: 'proveedor' });

export class ErrorProveedor extends Error {
  constructor(mensaje, { status, cuerpo, metodo, ruta, retryAfter, causa } = {}) {
    super(mensaje);
    this.name = 'ErrorProveedor';
    this.status = status ?? null;
    this.cuerpo = cuerpo ?? null;
    this.metodo = metodo ?? null;
    this.ruta = ruta ?? null;
    this.retryAfter = retryAfter ?? null;
    this.causa = causa ?? null;
  }

  /**
   * 429, 5xx y fallos de red se reintentan. Un 4xx no: el pedido esta mal
   * formado y reintentarlo solo gasta cuota.
   */
  get esReintentable() {
    if (this.status === null) return true;
    return this.status === 429 || this.status >= 500;
  }
}

const dormir = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

/*
 * Mercately no publica limite de llamadas. Espaciamos el arranque de cada
 * request para no ganarnos un bloqueo durante la carga inicial del catalogo,
 * que es justo cuando mas llamadas seguidas se hacen.
 */
let turno = Promise.resolve();
let ultimoArranque = 0;

function esperarTurno() {
  turno = turno.then(async () => {
    const falta = env.PROVIDER_MIN_INTERVAL_MS - (Date.now() - ultimoArranque);
    if (falta > 0) await dormir(falta);
    ultimoArranque = Date.now();
  });
  return turno;
}

function construirUrl(ruta, query) {
  const url = new URL(env.PROVIDER_BASE_URL + ruta);
  for (const [clave, valor] of Object.entries(query ?? {})) {
    if (valor !== undefined && valor !== null && valor !== '') {
      url.searchParams.set(clave, String(valor));
    }
  }
  return url;
}

async function llamar(metodo, url, body) {
  const headers = { 'api-key': env.PROVIDER_API_KEY, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const inicio = Date.now();
  let respuesta;

  try {
    respuesta = await fetch(url, {
      method: metodo,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(env.PROVIDER_TIMEOUT_MS),
    });
  } catch (causa) {
    throw new ErrorProveedor(`Fallo de red en ${metodo} ${url.pathname}`, {
      metodo,
      ruta: url.pathname,
      causa,
    });
  }

  // El proveedor no garantiza JSON en los errores: si no parsea, guardamos el texto crudo.
  const texto = await respuesta.text();
  let cuerpo = null;
  if (texto) {
    try {
      cuerpo = JSON.parse(texto);
    } catch {
      cuerpo = texto;
    }
  }

  const duracionMs = Date.now() - inicio;

  if (!respuesta.ok) {
    throw new ErrorProveedor(`${metodo} ${url.pathname} respondio ${respuesta.status}`, {
      status: respuesta.status,
      cuerpo,
      metodo,
      ruta: url.pathname,
      retryAfter: respuesta.headers.get('retry-after'),
    });
  }

  return { cuerpo, status: respuesta.status, duracionMs };
}

/** Backoff exponencial con jitter; si el proveedor manda Retry-After, mandamos eso. */
function calcularEspera(err, intento) {
  const retryAfter = Number(err.retryAfter);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 60_000);
  return Math.min(500 * 2 ** intento + Math.random() * 250, 30_000);
}

/** Punto unico de salida hacia el API del proveedor. */
export async function pedir(metodo, ruta, { query, body } = {}) {
  if (!proveedorConfigurado) {
    throw new ErrorProveedor('PROVIDER_BASE_URL o PROVIDER_API_KEY sin configurar en el .env');
  }

  const url = construirUrl(ruta, query);
  let ultimoError;

  for (let intento = 0; intento <= env.PROVIDER_MAX_RETRIES; intento += 1) {
    await esperarTurno();

    try {
      const resultado = await llamar(metodo, url, body);
      log.debug({ metodo, ruta, status: resultado.status, ms: resultado.duracionMs }, 'llamada ok');
      return resultado;
    } catch (err) {
      ultimoError = err;

      const quedanIntentos = intento < env.PROVIDER_MAX_RETRIES;
      if (!(err instanceof ErrorProveedor) || !err.esReintentable || !quedanIntentos) throw err;

      const espera = calcularEspera(err, intento);
      log.warn({ metodo, ruta, status: err.status, intento: intento + 1, espera }, 'reintentando');
      await dormir(espera);
    }
  }

  throw ultimoError;
}
