import { pedir } from './http.js';

/*
 * GET /categories no figuraba en la documentacion que entrego el proveedor,
 * pero existe y devuelve el arbol completo con los web_id de categorias y
 * subcategorias. Es lo que evita tener que sacarlos a mano del panel.
 */
const RUTA = '/categories';

/** Una pagina del arbol de categorias. */
export async function listarPagina(page = 1) {
  const { cuerpo } = await pedir('GET', RUTA, { query: { page } });
  return {
    categorias: Array.isArray(cuerpo?.categories) ? cuerpo.categories : [],
    totalPaginas: Number(cuerpo?.total_pages) || 1,
  };
}

/** El arbol completo, recorriendo todas las paginas. */
export async function listarTodas() {
  const todas = [];
  let page = 1;
  let totalPaginas = 1;

  do {
    const pagina = await listarPagina(page);
    totalPaginas = pagina.totalPaginas;
    todas.push(...pagina.categorias);
    page += 1;
  } while (page <= totalPaginas);

  return todas;
}

/**
 * Aplana el arbol a una lista de subcategorias, cada una con su categoria
 * padre. Es la forma en que la necesita el mapeo: Mercately solo recibe
 * `subcategory_id`, y deduce la categoria a partir de el.
 */
export async function listarSubcategorias() {
  const categorias = await listarTodas();
  const planas = [];

  for (const categoria of categorias) {
    for (const sub of categoria.subcategories ?? []) {
      planas.push({
        subcategoria: sub.name,
        subcategoriaWebId: sub.web_id,
        categoria: categoria.name,
        categoriaWebId: categoria.web_id,
        productos: sub.products_count ?? 0,
      });
    }
  }

  return planas;
}

/**
 * Busca una subcategoria por nombre, opcionalmente dentro de una categoria.
 *
 * Hace falta acotar por categoria porque los nombres se repiten entre ramas:
 * "almacenamiento interno" existe tanto en PARTES Y PIEZAS como en
 * ALMACENAMIENTO EXTERNO.
 */
export async function buscarSubcategoria(nombre, categoria = null) {
  const clave = (v) => String(v ?? '').trim().toLowerCase();
  const planas = await listarSubcategorias();

  return (
    planas.find(
      (s) =>
        clave(s.subcategoria) === clave(nombre) &&
        (categoria === null || clave(s.categoria) === clave(categoria))
    ) ?? null
  );
}
