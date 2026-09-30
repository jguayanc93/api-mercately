import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { logger } from '../utils/logger.js';
import { listarSubcategorias } from '../proveedor/categorias.js';

const ARCHIVO = resolve(dirname(fileURLToPath(import.meta.url)), '../../config/subcategorias.json');

const log = logger.child({ modulo: 'subcategorias' });

let mapa = new Map();
let porDefecto = null;
let cargado = false;

/** Normaliza la clave para que "Camisetas", " camisetas " y "CAMISETAS" sean lo mismo. */
const clave = (nombre) => String(nombre ?? '').trim().toLowerCase();

export async function cargar() {
  try {
    const crudo = JSON.parse(await readFile(ARCHIVO, 'utf8'));

    // Las entradas con valor vacio son plantillas a completar, no mapeos: se
    // descartan para que el producto se omita en vez de crearse sin categoria.
    const entradas = Object.entries(crudo.mapa ?? {}).filter(
      ([, webId]) => typeof webId === 'string' && webId.trim() !== ''
    );
    mapa = new Map(entradas.map(([k, v]) => [clave(k), v.trim()]));
    porDefecto = crudo.porDefecto?.trim?.() || null;

    const sinMapear = Object.keys(crudo.mapa ?? {}).length - entradas.length;
    cargado = true;

    if (mapa.size === 0 && !porDefecto) {
      log.warn(
        { sinMapear },
        'Ninguna subcategoria mapeada en config/subcategorias.json: no se podran CREAR productos'
      );
    } else {
      log.info({ subcategorias: mapa.size, sinMapear, porDefecto }, 'Mapeo de subcategorias cargado');
    }
  } catch (err) {
    log.error({ err, archivo: ARCHIVO }, 'No se pudo leer config/subcategorias.json');
    mapa = new Map();
    porDefecto = null;
    cargado = true;
  }
  return { total: mapa.size, porDefecto };
}

/**
 * Devuelve el `web_id` de subcategoria, o null si no hay forma de resolverlo.
 * Null significa "no crear este producto": es preferible omitirlo a publicarlo
 * en la categoria equivocada.
 */
export function resolverWebId(nombre) {
  if (!cargado) throw new Error('Llamar a subcategorias.cargar() antes de resolver');
  return mapa.get(clave(nombre)) ?? porDefecto ?? null;
}

export function estadoMapeo() {
  return {
    cargado,
    total: mapa.size,
    porDefecto,
    subcategorias: Object.fromEntries(mapa),
  };
}

/**
 * Trae el arbol de categorias de Mercately y lo contrasta con el mapeo actual.
 *
 * Usa `GET /categories`, que no figuraba en la documentacion del proveedor pero
 * existe y devuelve las subcategorias aunque esten vacias.
 */
export async function descubrirDesdeCatalogo() {
  const planas = await listarSubcategorias();
  const mapeados = new Set(mapa.values());

  return {
    total: planas.length,
    subcategorias: planas.map((s) => ({
      categoria: s.categoria,
      subcategoria: s.subcategoria,
      web_id: s.subcategoriaWebId,
      productos: s.productos,
      mapeada: mapeados.has(s.subcategoriaWebId),
    })),
    // Las que existen en Mercately pero ningun grupo del ERP apunta a ellas.
    sinUsar: planas
      .filter((s) => !mapeados.has(s.subcategoriaWebId))
      .map((s) => `${s.categoria} > ${s.subcategoria}  [${s.subcategoriaWebId}]`),
    // Los web_id del mapeo que ya no existen del otro lado.
    huerfanos: [...mapa.entries()]
      .filter(([, webId]) => !planas.some((s) => s.subcategoriaWebId === webId))
      .map(([grupo, webId]) => `${grupo} -> ${webId}`),
  };
}
