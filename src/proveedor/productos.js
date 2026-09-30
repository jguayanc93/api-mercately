import { pedir, ErrorProveedor } from './http.js';

const RUTA = '/products';

/* =====================================================================
   Lectura
   ===================================================================== */

/** GET /products?page=N */
export async function listarPagina(page = 1) {
  const { cuerpo } = await pedir('GET', RUTA, { query: { page } });
  return {
    productos: Array.isArray(cuerpo?.products) ? cuerpo.products : [],
    totalPaginas: Number(cuerpo?.total_pages) || 1,
  };
}

/** Recorre el catalogo completo pagina por pagina, sin cargarlo entero en memoria. */
export async function* recorrerCatalogo() {
  let page = 1;
  let totalPaginas = 1;

  do {
    const pagina = await listarPagina(page);
    totalPaginas = pagina.totalPaginas;
    for (const producto of pagina.productos) yield producto;
    page += 1;
  } while (page <= totalPaginas);
}

/**
 * Mapa `sku -> producto` de todo el catalogo remoto.
 *
 * Es lo que evita duplicar productos cuando una corrida anterior se corto a la
 * mitad: antes de crear, se mira si el SKU ya existe del otro lado.
 */
export async function catalogoPorSku() {
  const mapa = new Map();
  for await (const producto of recorrerCatalogo()) {
    if (producto?.sku) mapa.set(String(producto.sku), producto);
  }
  return mapa;
}

/**
 * GET de un producto puntual, por `web_id` o por SKU.
 *
 * El identificador va en la RUTA. La documentacion tambien mostraba `web_id` y
 * `sku` por query string, pero probado contra el API real esa forma devuelve
 * 404: el query se ignora. Un producto inexistente responde 404 con
 * `{"message":"Producto no encontrado"}`, que aca se traduce a null.
 */
async function obtener(valor) {
  try {
    const { cuerpo } = await pedir('GET', `${RUTA}/${encodeURIComponent(valor)}`);
    return cuerpo ?? null;
  } catch (err) {
    if (err instanceof ErrorProveedor && err.status === 404) return null;
    throw err;
  }
}

export const obtenerPorWebId = (webId) => obtener(webId);
export const obtenerPorSku = (sku) => obtener(sku);

/** Mercately responde 422 "Sku Ya esta en uso" si el SKU ya existe. */
export function esSkuDuplicado(err) {
  if (!(err instanceof ErrorProveedor) || err.status !== 422) return false;
  return JSON.stringify(err.cuerpo ?? '').toLowerCase().includes('sku');
}

/* =====================================================================
   Escritura
   ===================================================================== */

/**
 * POST /products
 *
 * Devuelve el producto creado, con su `web_id`: es el dato que hay que
 * persistir, porque sin el no se puede actualizar ni dar de baja despues.
 */
export async function crear(producto) {
  const { cuerpo } = await pedir('POST', RUTA, { body: { product: producto } });
  return cuerpo?.product ?? cuerpo;
}

/**
 * PUT /products/{web_id} — actualizacion PARCIAL.
 *
 * Solo se mandan los campos que cambiaron, para no pisar lo que alguien haya
 * editado a mano en el panel de Mercately.
 *
 * Nunca enviar `options` ni `variants`: el PUT del proveedor es solo-agregar y
 * no existe forma documentada de borrar una variante. Ver docs/decisiones.md.
 */
export async function actualizar(webId, cambios) {
  const { cuerpo } = await pedir('PUT', `${RUTA}/${encodeURIComponent(webId)}`, {
    body: { product: cambios },
  });
  return cuerpo?.product ?? cuerpo;
}

/** Baja logica: reversible y conserva el web_id, las imagenes y el historial. */
export const desactivar = (webId) => actualizar(webId, { active: false });
export const reactivar = (webId) => actualizar(webId, { active: true });

/**
 * DELETE /products/{web_id} — baja FISICA, presuntamente irreversible.
 *
 * El cron nunca llama a esto: solo se dispara a mano. La respuesta trae el
 * producto completo tal como estaba, y es el unico registro de lo borrado, asi
 * que hay que guardarla integra en sync_evento.
 */
export async function eliminar(webId) {
  const { cuerpo } = await pedir('DELETE', `${RUTA}/${encodeURIComponent(webId)}`);
  return cuerpo?.product ?? cuerpo;
}

/* =====================================================================
   Diagnostico
   ===================================================================== */

/** Verifica credenciales y conectividad pidiendo la primera pagina. */
export async function verificarConexion() {
  const inicio = Date.now();
  const { totalPaginas, productos } = await listarPagina(1);
  return {
    ok: true,
    totalPaginas,
    productosEnPrimeraPagina: productos.length,
    ms: Date.now() - inicio,
  };
}
