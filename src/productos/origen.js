/* =====================================================================
   Adaptador de la tabla de productos de SQL Server.

   Es el UNICO punto del proyecto que conoce el esquema de origen. Todo lo
   demas trabaja contra el objeto normalizado que devuelve `leerProductos()`.

   La tabla es de SOLO LECTURA: la alimenta otra fuente y esta API nunca la
   escribe.
   ===================================================================== */

import { queryRows } from '../config/db.js';
import { limpiarHtml } from '../utils/texto.js';
import { normalizarEntero, normalizarPrecio, normalizarTexto } from '../utils/normalizar.js';

export const ORIGEN_CONFIGURADO = true;

/**
 * Productos a publicar en Mercately.
 *
 * El WHERE es la regla de disponibilidad: todo lo que sale de aca esta
 * disponible, y lo que deja de salir se da de baja en Mercately con
 * `active: false`. Por eso no hace falta una columna `disponible`.
 *
 * Decisiones tomadas sobre el mapeo (ver docs/decisiones.md):
 *   - stock  = stoc - svta - pedi, el disponible real. La misma formula que
 *              usa el filtro; publicar `stoc` a secas sobrevenderia el 24% del
 *              catalogo (ej. codi 0102-010292: stoc 53, disponible 3).
 *   - precio = vvus, en dolares, SIN IGV y SIN descuento de categoria.
 *              La tabla tambien tiene `pvus` (= vvus * 1.18, con IGV) e
 *              `igvus`, por si algun dia se publica el precio al publico.
 *   - subcategoria = LEFT(codi,2), que es el codigo de familia de tbl01fam.
 */
export const SQL_PRODUCTOS = `
  SELECT
      a.codi                       AS sku,
      a.descr                      AS titulo,
      a.obse                       AS descripcion,
      a.marc                       AS marca,
      a.vvus                       AS precio,
      (a.stoc - a.svta - a.pedi)   AS stock,
      LEFT(a.codi, 2)              AS familia_codigo,
      LEFT(a.codi, 4)              AS grupo_codigo,
      f.nomfam                     AS familia_nombre,
      b.dscto_maxven               AS descuento_max,
      a.rutaimage                  AS imagen_archivo
    FROM prd0101 AS a
    LEFT JOIN Dtl_Dscto_Marca_Tc AS b ON (a.codmar = b.codmar AND b.codtcl = 'A')
    LEFT JOIN tbl01fam           AS f ON  f.codfam = LEFT(a.codi, 2)
   WHERE a.estado = '1'
     AND LEFT(a.codi, 2) IN ('01','02','05','06','09','10','11','12','13')
     AND (a.stoc - a.svta - a.pedi) > 1
     AND a.vvus > 0
`;

/**
 * Fila cruda -> producto normalizado.
 *
 * Los campos char/varchar de esta base vienen con relleno de espacios, asi que
 * todo pasa por trim.
 */
export function mapearFila(fila) {
  const titulo = normalizarTexto(fila.titulo);

  return {
    sku: normalizarTexto(fila.sku),
    titulo,
    // `obse` mezcla texto plano, HTML y vacios; donde no haya nada usable se
    // cae al titulo, que es el unico texto siempre presente.
    descripcion: limpiarHtml(fila.descripcion) ?? titulo,
    precio: normalizarPrecio(fila.precio),
    stock: normalizarEntero(fila.stock) ?? 0,
    // Todo lo que devuelve la consulta esta disponible por definicion del WHERE.
    disponible: true,
    /*
     * El grupo de 4 digitos de `codi`, no la familia de 2.
     *
     * Las 9 familias del ERP coinciden con las 9 CATEGORIAS de Mercately, pero
     * Mercately solo recibe `subcategory_id` y deduce la categoria de ahi. El
     * segundo nivel del codigo es el que identifica el tipo de producto:
     * 0505 tinta, 0506 toner, 0601 ram, 0603 procesadores, etc.
     */
    subcategoria: normalizarTexto(fila.grupo_codigo),
    // Pendiente: `rutaimage` trae solo el nombre del archivo (825 de 1086 lo
    // tienen). Falta la URL base publica donde se sirven para poder mandarlas.
    imagenes: [],

    // Informativos: hoy no viajan a Mercately, quedan para diagnostico.
    marca: normalizarTexto(fila.marca),
    familiaCodigo: normalizarTexto(fila.familia_codigo),
    familiaNombre: normalizarTexto(fila.familia_nombre),
    descuentoMax: fila.descuento_max ?? null,
    imagenArchivo: normalizarTexto(fila.imagen_archivo),
  };
}

export class OrigenNoConfigurado extends Error {
  constructor() {
    super(
      'El origen de datos no esta configurado. Ajustar SQL_PRODUCTOS y mapearFila ' +
        'en src/productos/origen.js, y poner ORIGEN_CONFIGURADO en true.'
    );
    this.name = 'OrigenNoConfigurado';
    this.status = 503;
  }
}

/** Lee la tabla de origen y devuelve los productos ya normalizados. */
export async function leerProductos() {
  if (!ORIGEN_CONFIGURADO) throw new OrigenNoConfigurado();

  const filas = await queryRows(SQL_PRODUCTOS);
  const productos = [];
  const descartados = [];

  for (const fila of filas) {
    const producto = mapearFila(fila);

    // Mercately exige title y sku, y el sku ademas es nuestra clave de
    // emparejamiento: sin alguno de los dos el producto no se puede publicar.
    if (!producto.sku || !producto.titulo) {
      descartados.push({ sku: producto.sku, titulo: producto.titulo, motivo: 'sku o titulo vacio' });
      continue;
    }
    if (producto.precio === null) {
      descartados.push({ sku: producto.sku, motivo: 'precio no numerico' });
      continue;
    }

    productos.push(producto);
  }

  return { productos, descartados };
}

/** Diagnostico: corre la consulta y muestra como queda normalizada, sin sincronizar. */
export async function inspeccionar(limite = 5) {
  const filas = await queryRows(SQL_PRODUCTOS);
  return {
    configurado: ORIGEN_CONFIGURADO,
    totalFilas: filas.length,
    columnas: filas.length ? Object.keys(filas[0]) : [],
    ejemploCrudo: filas.slice(0, limite),
    ejemploNormalizado: filas.slice(0, limite).map(mapearFila),
  };
}
