import { precioANumero, hashEstable, camposQueCambiaron } from '../utils/normalizar.js';

/**
 * Producto normalizado -> payload de Mercately.
 *
 * Nunca incluye `options` ni `variants`: el catalogo no maneja variantes, y el
 * PUT del proveedor es solo-agregar sin forma documentada de borrar una vez
 * creadas. Ver docs/decisiones.md.
 */
export function aPayload(producto, subcategoriaWebId) {
  const payload = {
    title: producto.titulo,
    description: producto.descripcion ?? '',
    sku: producto.sku,
    quantity: producto.stock ?? 0,
    active: producto.disponible,
    price: precioANumero(producto.precio) ?? 0,
  };

  if (subcategoriaWebId) payload.subcategory_id = subcategoriaWebId;
  if (producto.imagenes?.length) payload.image_urls = producto.imagenes;

  return payload;
}

/** La huella que se guarda en sync_producto y decide si hace falta sincronizar. */
export const huella = (payload) => hashEstable(payload);

/**
 * Campos a enviar en un PUT: solo los que cambiaron respecto del ultimo envio.
 *
 * Mandar el payload completo funcionaria, pero pisaria cualquier cosa que
 * alguien haya editado a mano en el panel de Mercately. El PUT acepta parciales,
 * asi que no hay razon para hacerlo.
 */
export function delta(payloadNuevo, payloadAnterior, { incluirImagenes = false } = {}) {
  const cambios = camposQueCambiaron(payloadNuevo, payloadAnterior);

  // `image_urls` en el PUT es ambiguo: el proveedor no documenta si reemplaza
  // la galeria o si agrega a la existente. Si agrega, reenviarlas en cada ciclo
  // duplicaria las imagenes sin forma de limpiarlas. Por defecto no se tocan
  // despues de la creacion.
  if (!incluirImagenes) delete cambios.image_urls;

  // El sku identifica al producto de nuestro lado: no se renombra desde aca.
  delete cambios.sku;

  return cambios;
}

/** Lee el estado publicado en Mercately, para comparar contra lo nuestro. */
export function payloadRemoto(productoRemoto) {
  return {
    title: productoRemoto?.title ?? null,
    description: productoRemoto?.description ?? '',
    sku: productoRemoto?.sku ?? null,
    quantity: productoRemoto?.quantity ?? 0,
    active: productoRemoto?.active ?? null,
    price: precioANumero(productoRemoto?.price) ?? 0,
    subcategory_id: productoRemoto?.subcategory?.web_id ?? undefined,
  };
}
