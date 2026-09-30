import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { leerProductos } from '../productos/origen.js';
import { aPayload, huella, delta, payloadRemoto } from '../productos/mapeo.js';
import { resolverWebId } from '../productos/subcategorias.js';
import { precioANumero } from '../utils/normalizar.js';
import * as proveedor from '../proveedor/productos.js';
import * as repo from '../repos/syncRepo.js';

const log = logger.child({ modulo: 'sync' });

/*
 * Una sola corrida a la vez. Si el catalogo es grande, una sincronizacion puede
 * durar mas que el intervalo del cron; sin este candado se solaparian dos
 * corridas y se pisarian entre si.
 */
let corriendo = false;
export const estaCorriendo = () => corriendo;

/**
 * Cuantos productos entran por pagina en `GET /products`. Mercately no lo
 * documenta ni permite cambiarlo; se midio contra el API real (1.088 productos
 * repartidos en 55 paginas). Solo se usa para decidir cual de las dos formas de
 * emparejar sale mas barata, asi que un valor algo desfasado no rompe nada.
 */
const PRODUCTOS_POR_PAGINA = 20;

/** Procesa `items` con `limite` tareas en paralelo, preservando el orden del resultado. */
async function enParalelo(items, limite, tarea) {
  const resultados = new Array(items.length);
  let siguiente = 0;

  const trabajadores = Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (siguiente < items.length) {
      const i = siguiente;
      siguiente += 1;
      resultados[i] = await tarea(items[i], i);
    }
  });

  await Promise.all(trabajadores);
  return resultados;
}

/** Envuelve una llamada al proveedor para dejarla registrada en sync_evento. */
async function llamarProveedor({ operacion, sku, webId, peticion, fn, idEjecucion, persistir }) {
  const inicio = Date.now();

  try {
    const respuesta = await fn();
    if (persistir) {
      await repo.registrarEvento({
        idEjecucion,
        sku,
        idProveedor: webId ?? respuesta?.web_id ?? null,
        operacion,
        resultado: 'OK',
        peticion,
        respuesta,
        duracionMs: Date.now() - inicio,
      });
    }
    return respuesta;
  } catch (err) {
    if (persistir) {
      await repo.registrarEvento({
        idEjecucion,
        sku,
        idProveedor: webId,
        operacion,
        resultado: 'ERROR',
        httpStatus: err.status ?? null,
        peticion,
        respuesta: err.cuerpo ?? null,
        mensajeError: err.message,
        duracionMs: Date.now() - inicio,
      });
    }
    throw err;
  }
}

/* =====================================================================
   Un producto
   ===================================================================== */

/**
 * Crea el producto en Mercately.
 *
 * Si responde 422 "Sku Ya esta en uso", el producto ya existe alla pero no
 * teniamos su `web_id`: se resuelve por SKU y se devuelve para seguir por la
 * rama de actualizacion. Pasa cuando el estado local se perdio, o cuando un
 * producto se creo entre la lectura del catalogo remoto y este POST.
 */
async function crearOAdoptar(producto, payload, ctx) {
  const { idEjecucion, persistir } = ctx;

  try {
    const creado = await llamarProveedor({
      operacion: 'CREAR',
      sku: producto.sku,
      webId: null,
      peticion: payload,
      idEjecucion,
      persistir,
      fn: () => proveedor.crear(payload),
    });
    return { creado, webId: creado?.web_id ?? null, remoto: null };
  } catch (err) {
    if (!proveedor.esSkuDuplicado(err)) throw err;

    const remoto = await proveedor.obtenerPorSku(producto.sku);
    if (!remoto?.web_id) throw err;

    log.warn(
      { sku: producto.sku, webId: remoto.web_id },
      'El SKU ya existia en Mercately: se adopta su web_id en vez de crear'
    );
    await repo.vincularWebId(producto.sku, remoto.web_id);
    return { creado: null, webId: remoto.web_id, remoto };
  }
}

async function procesarProducto(producto, ctx) {
  const { estados, remoto, idEjecucion, persistir } = ctx;
  const estado = estados.get(producto.sku) ?? null;

  const subcategoriaWebId = resolverWebId(producto.subcategoria);
  const payload = aPayload(producto, subcategoriaWebId);
  const hash = huella(payload);

  let webId = estado?.id_proveedor ?? null;

  // Nada cambio desde el ultimo envio: ni una llamada al proveedor.
  if (webId && estado?.hash_payload === hash) {
    return { tipo: 'sinCambios', sku: producto.sku };
  }

  // Sin web_id propio, pero el SKU ya existe del otro lado: lo adoptamos en vez
  // de crear un duplicado. Es lo que hace segura una corrida que se corto a la mitad.
  if (!webId && remoto?.has(producto.sku)) {
    webId = remoto.get(producto.sku).web_id;
    if (persistir) await repo.vincularWebId(producto.sku, webId);
    log.info({ sku: producto.sku, webId }, 'SKU ya existia en el proveedor: se adopta su web_id');
  }

  /* ---------- Alta ---------- */
  let remotoAdoptado = null;

  if (!webId) {
    /*
     * Probado contra el API real: `subcategory_id` es opcional y el producto se
     * crea con categoria null. Con SYNC_EXIGIR_SUBCATEGORIA=true se prefiere
     * omitir el producto antes que publicarlo sin categorizar.
     */
    if (!subcategoriaWebId && env.SYNC_EXIGIR_SUBCATEGORIA) {
      throw Object.assign(
        new Error(
          `Sin subcategoria mapeada para "${producto.subcategoria ?? '(vacia)'}". ` +
            'Agregarla en config/subcategorias.json, o poner SYNC_EXIGIR_SUBCATEGORIA=false.'
        ),
        { status: 422 }
      );
    }

    if (!persistir) {
      return { tipo: 'creado', sku: producto.sku, webId: '(simulacion)', payload };
    }

    const alta = await crearOAdoptar(producto, payload, ctx);

    if (alta.creado) {
      await repo.registrarExito({
        sku: producto.sku,
        idProveedor: alta.webId,
        hash,
        payload,
        precio: precioANumero(producto.precio),
        stock: producto.stock,
        activo: producto.disponible,
      });
      return { tipo: 'creado', sku: producto.sku, webId: alta.webId, payload };
    }

    // El SKU ya existia: seguimos por la rama de actualizacion.
    webId = alta.webId;
    remotoAdoptado = alta.remoto;
  }

  /* ---------- Actualizacion parcial ---------- */
  // Se compara contra lo ultimo que enviamos. Si nunca enviamos nada (por
  // ejemplo, recien adoptamos el web_id), se compara contra el estado remoto.
  const anterior = estado?.payload ?? payloadRemoto(remotoAdoptado ?? remoto?.get(producto.sku));
  const cambios = delta(payload, anterior, {
    incluirImagenes: env.SYNC_ENVIAR_IMAGENES_EN_UPDATE,
  });

  if (Object.keys(cambios).length === 0) {
    // El hash cambio pero no hay nada que enviar (tipico al adoptar un web_id, o
    // si lo unico distinto son las imagenes, que no se reenvian). Se guarda la
    // huella para no recalcular esto en cada ciclo.
    if (persistir) {
      await repo.registrarExito({
        sku: producto.sku,
        idProveedor: webId,
        hash,
        payload,
        precio: precioANumero(producto.precio),
        stock: producto.stock,
        activo: producto.disponible,
      });
    }
    return { tipo: 'sinCambios', sku: producto.sku };
  }

  if (persistir) {
    await llamarProveedor({
      operacion: cambios.active === false ? 'BAJA' : 'ACTUALIZAR',
      sku: producto.sku,
      webId,
      peticion: cambios,
      idEjecucion,
      persistir,
      fn: () => proveedor.actualizar(webId, cambios),
    });

    await repo.registrarExito({
      sku: producto.sku,
      idProveedor: webId,
      hash,
      payload,
      precio: precioANumero(producto.precio),
      stock: producto.stock,
      activo: producto.disponible,
    });
  }

  return {
    tipo: cambios.active === false ? 'baja' : 'actualizado',
    sku: producto.sku,
    webId,
    cambios,
  };
}

/* =====================================================================
   Bajas: productos que ya no vienen del origen
   ===================================================================== */

function calcularBajas(estados, skusVigentes) {
  const bajas = [];

  for (const [sku, estado] of estados) {
    const yaInactivo = estado.activo_enviado === false;
    const nuncaPublicado = !estado.id_proveedor;
    if (skusVigentes.has(sku) || yaInactivo || nuncaPublicado) continue;
    bajas.push({ sku, webId: estado.id_proveedor, estado });
  }

  return bajas;
}

async function procesarBajas(bajas, ctx) {
  const { idEjecucion, persistir } = ctx;

  return enParalelo(bajas, env.SYNC_CONCURRENCIA, async ({ sku, webId, estado }) => {
    try {
      if (persistir) {
        await llamarProveedor({
          operacion: 'BAJA',
          sku,
          webId,
          peticion: { active: false },
          idEjecucion,
          persistir,
          fn: () => proveedor.desactivar(webId),
        });

        const payload = { ...(estado.payload ?? {}), active: false };
        await repo.registrarExito({
          sku,
          idProveedor: webId,
          hash: huella(payload),
          payload,
          precio: estado.precio_enviado,
          stock: estado.stock_enviado,
          activo: false,
        });
      }
      return { tipo: 'baja', sku, webId };
    } catch (err) {
      log.error({ err, sku }, 'Fallo la baja');
      if (persistir) await repo.registrarFallo({ sku, mensaje: err.message });
      return { tipo: 'error', sku, error: err.message };
    }
  });
}

/* =====================================================================
   Corrida completa
   ===================================================================== */

/**
 * @param {object}  opciones
 * @param {string}  opciones.origen      CRON | MANUAL
 * @param {boolean} opciones.simulacion  calcula todo pero no llama ni escribe
 * @param {number?} opciones.limite      procesa solo los primeros N productos.
 *                                       Pensado para una tanda de prueba: con
 *                                       limite NO se dan bajas (ver abajo).
 */
export async function sincronizar({ origen = 'CRON', simulacion = false, limite = null } = {}) {
  if (corriendo) {
    throw Object.assign(new Error('Ya hay una sincronizacion en curso'), { status: 409 });
  }
  corriendo = true;

  const persistir = !simulacion;
  const contadores = { leidos: 0, creados: 0, actualizados: 0, eliminados: 0, sinCambios: 0, errores: 0 };
  const incidencias = [];
  let idEjecucion = null;
  const inicio = Date.now();

  try {
    if (persistir) idEjecucion = await repo.iniciarEjecucion(origen);
    log.info({ origen, simulacion, idEjecucion }, 'Sincronizacion iniciada');

    const { productos: disponibles, descartados } = await leerProductos();
    const productos = limite ? disponibles.slice(0, limite) : disponibles;

    contadores.leidos = productos.length;
    for (const d of descartados) incidencias.push({ ...d, tipo: 'descartado' });

    if (limite) {
      log.warn(
        { limite, deUnTotalDe: disponibles.length },
        'Corrida limitada: es una tanda de prueba, no una sincronizacion completa'
      );
    }

    const estados = await repo.obtenerEstados();

    /*
     * Los grupos del ERP se mueven: aparece uno nuevo y queda sin subcategoria
     * hasta que alguien lo agregue al mapeo. No bloquea la corrida, pero tiene
     * que verse, porque si no esos productos se publican sin categorizar y
     * nadie se entera.
     */
    const sinMapear = new Map();
    for (const p of productos) {
      if (!resolverWebId(p.subcategoria)) {
        sinMapear.set(p.subcategoria, (sinMapear.get(p.subcategoria) ?? 0) + 1);
      }
    }
    if (sinMapear.size > 0) {
      const detalle = Object.fromEntries(sinMapear);
      log.warn({ grupos: detalle }, 'Grupos sin subcategoria mapeada');
      incidencias.push({
        tipo: 'subcategorias_sin_mapear',
        detalle: 'Agregar estos grupos en config/subcategorias.json',
        grupos: detalle,
      });
    }

    /*
     * Emparejar contra lo que ya existe en Mercately evita duplicar productos
     * cuando el estado local se perdio o una corrida quedo a medias. Hay dos
     * formas de averiguarlo y conviene la mas barata de las dos:
     *
     *   - recorrer el catalogo cuesta una llamada cada 20 productos publicados
     *     (Mercately pagina de a 20, medido: 1.088 productos en 55 paginas);
     *   - preguntar por SKU cuesta una llamada por producto sin web_id.
     *
     * Con el catalogo ya cargado, lo normal es que aparezcan unos pocos
     * productos nuevos por ciclo: preguntar por cada uno sale mucho mas barato
     * que releer 55 paginas. Si no falta ninguno, no se gasta ni una llamada.
     */
    const sinWebId = productos.filter((p) => !estados.get(p.sku)?.id_proveedor);
    let remoto = null;

    if (sinWebId.length > 0) {
      const paginasEstimadas = Math.ceil(Math.max(estados.size, 1) / PRODUCTOS_POR_PAGINA);

      if (sinWebId.length <= paginasEstimadas) {
        remoto = new Map();
        await enParalelo(sinWebId, env.SYNC_CONCURRENCIA, async (p) => {
          const encontrado = await proveedor.obtenerPorSku(p.sku);
          if (encontrado?.web_id) remoto.set(p.sku, encontrado);
        });
        log.info(
          { consultados: sinWebId.length, encontrados: remoto.size },
          'Emparejamiento por SKU (mas barato que releer el catalogo)'
        );
      } else {
        remoto = await proveedor.catalogoPorSku();
        log.info({ productosRemotos: remoto.size }, 'Catalogo remoto completo leido para emparejar');
      }
    }

    const ctx = { estados, remoto, idEjecucion, persistir };

    const resultados = await enParalelo(productos, env.SYNC_CONCURRENCIA, async (producto) => {
      try {
        return await procesarProducto(producto, ctx);
      } catch (err) {
        log.error({ err, sku: producto.sku }, 'Fallo el producto');
        if (persistir) await repo.registrarFallo({ sku: producto.sku, mensaje: err.message });
        return { tipo: 'error', sku: producto.sku, error: err.message };
      }
    });

    for (const r of resultados) {
      if (r.tipo === 'creado') contadores.creados += 1;
      else if (r.tipo === 'actualizado') contadores.actualizados += 1;
      else if (r.tipo === 'baja') contadores.eliminados += 1;
      else if (r.tipo === 'sinCambios') contadores.sinCambios += 1;
      else if (r.tipo === 'error') {
        contadores.errores += 1;
        incidencias.push({ tipo: 'error', sku: r.sku, error: r.error });
      }
    }

    /* ---------- Bajas, con freno de mano ---------- */
    if (limite) {
      /*
       * Una corrida limitada no mira todos los productos vigentes, asi que no
       * puede deducir cuales desaparecieron: dar de baja aca apagaria todo lo
       * que simplemente no entro en la tanda.
       */
      incidencias.push({
        tipo: 'bajas_salteadas',
        detalle: `Corrida limitada a ${limite} productos: la fase de bajas se saltea por seguridad.`,
      });
    } else {
      const skusVigentes = new Set(productos.map((p) => p.sku));
      const bajas = calcularBajas(estados, skusVigentes);

      if (bajas.length > 0) {
        const publicados = [...estados.values()].filter(
          (e) => e.id_proveedor && e.activo_enviado !== false
        ).length;
        const porcentaje = publicados === 0 ? 100 : (bajas.length / publicados) * 100;

        if (porcentaje > env.SYNC_MAX_BAJAS_PORCENTAJE) {
          const aviso =
            `Se abortaron las bajas: ${bajas.length} de ${publicados} productos publicados ` +
            `(${porcentaje.toFixed(1)}%) supera el limite de ${env.SYNC_MAX_BAJAS_PORCENTAJE}%. ` +
            'Suele indicar que la consulta de origen devolvio menos filas de las que debia.';
          log.error({ bajas: bajas.length, publicados, porcentaje }, aviso);
          incidencias.push({ tipo: 'bajas_abortadas', detalle: aviso, skus: bajas.map((b) => b.sku) });
        } else {
          const resultadosBaja = await procesarBajas(bajas, ctx);
          for (const r of resultadosBaja) {
            if (r.tipo === 'baja') contadores.eliminados += 1;
            else if (r.tipo === 'error') {
              contadores.errores += 1;
              incidencias.push({ tipo: 'error', sku: r.sku, error: r.error });
            }
          }
        }
      }
    }

    const estado = contadores.errores > 0 ? 'ERROR' : 'OK';
    if (persistir) await repo.cerrarEjecucion(idEjecucion, { estado, contadores });

    const resumen = {
      idEjecucion,
      origen,
      simulacion,
      limite,
      estado,
      contadores,
      incidencias,
      duracionMs: Date.now() - inicio,
    };
    log.info(resumen, 'Sincronizacion terminada');
    return resumen;
  } catch (err) {
    log.error({ err }, 'Sincronizacion abortada');
    if (persistir && idEjecucion) {
      await repo
        .cerrarEjecucion(idEjecucion, { estado: 'ERROR', contadores, mensajeError: err.message })
        .catch((e) => log.error({ err: e }, 'No se pudo cerrar la ejecucion'));
    }
    throw err;
  } finally {
    corriendo = false;
  }
}
