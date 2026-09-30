import { Router } from 'express';

import { sincronizar, estaCorriendo } from '../sync/sincronizador.js';
import { estadoCron } from '../sync/cron.js';
import { inspeccionar, ORIGEN_CONFIGURADO } from '../productos/origen.js';
import { estadoMapeo, descubrirDesdeCatalogo, cargar } from '../productos/subcategorias.js';
import { verificarConexion } from '../proveedor/productos.js';
import * as repo from '../repos/syncRepo.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

/**
 * Dispara una sincronizacion a mano.
 *
 * `?simulacion=true` calcula todo (lee la BD, compara huellas, arma los deltas)
 * pero no llama al proveedor ni escribe nada. Es la forma de ver que haria la
 * primera corrida antes de dejarla tocar la tienda.
 *
 * `?limite=N` procesa solo los primeros N productos, para una tanda de prueba.
 * Una corrida limitada NO da de baja nada: no mira todos los productos
 * vigentes, asi que no puede saber cuales desaparecieron de verdad.
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const simulacion = req.query.simulacion === 'true';

    let limite = null;
    if (req.query.limite !== undefined) {
      limite = Number(req.query.limite);
      if (!Number.isInteger(limite) || limite < 1) {
        return res.status(400).json({ error: 'limite debe ser un entero mayor que 0' });
      }
    }

    res.json(await sincronizar({ origen: 'MANUAL', simulacion, limite }));
  })
);

/** Tablero: como venimos. */
router.get(
  '/estado',
  asyncHandler(async (_req, res) => {
    const tablas = await repo.verificarTablas();

    // Sin las tablas creadas, el resumen no se puede calcular: se informa que
    // falta en lugar de devolver un error de SQL crudo.
    if (!tablas.ok) {
      return res.status(503).json({
        error: 'Faltan tablas de sincronizacion',
        detalle: `Ejecutar sql/001_tablas_sync.sql. Faltan: ${tablas.faltan.join(', ')}`,
        tablas,
        cron: estadoCron(),
        origenConfigurado: ORIGEN_CONFIGURADO,
      });
    }

    const resumen = await repo.resumen();
    res.json({
      ...resumen,
      corriendo: estaCorriendo(),
      cron: estadoCron(),
      origenConfigurado: ORIGEN_CONFIGURADO,
      tablas,
      subcategorias: estadoMapeo(),
    });
  })
);

router.get(
  '/ejecuciones',
  asyncHandler(async (req, res) => {
    const limite = Math.min(Number(req.query.limite) || 20, 100);
    res.json({ ejecuciones: await repo.ultimasEjecuciones(limite) });
  })
);

/** Que paso exactamente con un SKU. */
router.get(
  '/eventos/:sku',
  asyncHandler(async (req, res) => {
    const limite = Math.min(Number(req.query.limite) || 50, 200);
    res.json({ sku: req.params.sku, eventos: await repo.eventosDeSku(req.params.sku, limite) });
  })
);

/* ---------------------------------------------------------------------
   Diagnostico
   --------------------------------------------------------------------- */

/** Corre la consulta de origen y muestra como queda normalizada, sin sincronizar. */
router.get(
  '/origen',
  asyncHandler(async (req, res) => {
    const limite = Math.min(Number(req.query.limite) || 5, 50);
    try {
      res.json(await inspeccionar(limite));
    } catch (err) {
      res.status(503).json({
        configurado: ORIGEN_CONFIGURADO,
        error: err.message,
        detalle: 'Revisar SQL_PRODUCTOS en src/productos/origen.js',
      });
    }
  })
);

/** Verifica credenciales y conectividad contra Mercately. */
router.get(
  '/proveedor',
  asyncHandler(async (_req, res) => {
    res.json(await verificarConexion());
  })
);

router.get('/subcategorias', (_req, res) => {
  res.json(estadoMapeo());
});

/**
 * Extrae los pares `nombre -> web_id` del catalogo de Mercately.
 *
 * Solo devuelve subcategorias que ya tengan al menos un producto: las vacias no
 * aparecen en ningun endpoint del proveedor.
 */
router.post(
  '/subcategorias/descubrir',
  asyncHandler(async (_req, res) => {
    const resultado = await descubrirDesdeCatalogo();
    res.json({
      ...resultado,
      comoUsarlo: 'Pegar "mapaSugerido" dentro de "mapa" en config/subcategorias.json',
    });
  })
);

/** Recarga config/subcategorias.json sin reiniciar el proceso. */
router.post(
  '/subcategorias/recargar',
  asyncHandler(async (_req, res) => {
    await cargar();
    res.json(estadoMapeo());
  })
);

export default router;
