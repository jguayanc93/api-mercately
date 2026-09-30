import { Router } from 'express';
import { z } from 'zod';

import * as proveedor from '../proveedor/productos.js';
import * as repo from '../repos/syncRepo.js';
import { resolverWebId } from '../productos/subcategorias.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

const esquemaAlta = z.object({
  title: z.string().min(1),
  description: z.string().optional().default(''),
  sku: z.string().min(1),
  quantity: z.number().int().nonnegative().optional().default(0),
  active: z.boolean().optional().default(true),
  price: z.number().nonnegative(),
  // O el web_id directo, o el nombre de subcategoria que se traduce por config.
  subcategory_id: z.string().optional(),
  subcategoria: z.string().optional(),
  image_urls: z.array(z.string().url()).optional(),
});

// En la actualizacion todo es opcional: el PUT del proveedor acepta parciales.
const esquemaEdicion = esquemaAlta.partial().omit({ sku: true });

function validar(esquema, cuerpo) {
  const resultado = esquema.safeParse(cuerpo);
  if (!resultado.success) {
    throw Object.assign(new Error('Cuerpo invalido'), {
      status: 422,
      detalle: resultado.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  return resultado.data;
}

/** Traduce el nombre de subcategoria a web_id si vino por nombre. */
function resolverSubcategoria(datos) {
  const { subcategoria, ...resto } = datos;
  if (resto.subcategory_id) return resto;
  if (!subcategoria) return resto;

  const webId = resolverWebId(subcategoria);
  if (!webId) {
    throw Object.assign(new Error(`Subcategoria "${subcategoria}" sin mapear`), {
      status: 422,
      detalle: 'Agregarla en config/subcategorias.json',
    });
  }
  return { ...resto, subcategory_id: webId };
}

/** Busca el web_id: primero en nuestro estado, si no, preguntando al proveedor. */
async function resolverWebIdDeSku(sku) {
  const estado = await repo.obtenerEstado(sku);
  if (estado?.id_proveedor) return estado.id_proveedor;

  const remoto = await proveedor.obtenerPorSku(sku);
  if (remoto?.web_id) {
    await repo.vincularWebId(sku, remoto.web_id);
    return remoto.web_id;
  }

  throw Object.assign(new Error(`No existe un producto con SKU "${sku}" en Mercately`), {
    status: 404,
  });
}

/* ---------------------------------------------------------------------
   Lectura
   --------------------------------------------------------------------- */

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const page = Number(req.query.page) || 1;
    const { productos, totalPaginas } = await proveedor.listarPagina(page);
    res.json({ page, totalPaginas, total: productos.length, productos });
  })
);

/** Producto puntual: el estado publicado en Mercately junto al nuestro. */
router.get(
  '/:sku',
  asyncHandler(async (req, res) => {
    const { sku } = req.params;
    const [remoto, estado] = await Promise.all([
      proveedor.obtenerPorSku(sku),
      repo.obtenerEstado(sku),
    ]);

    if (!remoto && !estado) {
      return res.status(404).json({ error: `Sin rastro del SKU "${sku}"` });
    }

    res.json({
      sku,
      enMercately: remoto,
      estadoSincronizacion: estado,
    });
  })
);

/* ---------------------------------------------------------------------
   Escritura
   --------------------------------------------------------------------- */

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const payload = resolverSubcategoria(validar(esquemaAlta, req.body));
    const creado = await proveedor.crear(payload);

    await repo.registrarExito({
      sku: payload.sku,
      idProveedor: creado?.web_id ?? null,
      hash: null,
      payload,
      precio: payload.price,
      stock: payload.quantity,
      activo: payload.active,
    });

    await repo.registrarEvento({
      sku: payload.sku,
      idProveedor: creado?.web_id ?? null,
      operacion: 'CREAR',
      resultado: 'OK',
      peticion: payload,
      respuesta: creado,
    });

    res.status(201).json({ producto: creado });
  })
);

router.put(
  '/:sku',
  asyncHandler(async (req, res) => {
    const { sku } = req.params;
    const cambios = resolverSubcategoria(validar(esquemaEdicion, req.body));

    if (Object.keys(cambios).length === 0) {
      return res.status(400).json({ error: 'No se envio ningun campo a actualizar' });
    }

    const webId = await resolverWebIdDeSku(sku);
    const actualizado = await proveedor.actualizar(webId, cambios);

    await repo.registrarEvento({
      sku,
      idProveedor: webId,
      operacion: 'ACTUALIZAR',
      resultado: 'OK',
      peticion: cambios,
      respuesta: actualizado,
    });

    res.json({ producto: actualizado });
  })
);

/** Baja logica: reversible. Es la forma recomendada de sacar un producto. */
router.post(
  '/:sku/desactivar',
  asyncHandler(async (req, res) => {
    const { sku } = req.params;
    const webId = await resolverWebIdDeSku(sku);
    const producto = await proveedor.desactivar(webId);

    await repo.registrarExito({
      sku,
      idProveedor: webId,
      hash: null,
      payload: null,
      precio: null,
      stock: null,
      activo: false,
    });
    await repo.registrarEvento({
      sku,
      idProveedor: webId,
      operacion: 'BAJA',
      resultado: 'OK',
      peticion: { active: false },
      respuesta: producto,
    });

    res.json({ producto });
  })
);

router.post(
  '/:sku/reactivar',
  asyncHandler(async (req, res) => {
    const { sku } = req.params;
    const webId = await resolverWebIdDeSku(sku);
    const producto = await proveedor.reactivar(webId);

    await repo.registrarEvento({
      sku,
      idProveedor: webId,
      operacion: 'ACTUALIZAR',
      resultado: 'OK',
      peticion: { active: true },
      respuesta: producto,
    });

    res.json({ producto });
  })
);

/**
 * Baja FISICA. El cron nunca llega aca: solo se dispara a mano.
 *
 * Se exige `?confirmar=si` porque es presuntamente irreversible: si el producto
 * vuelve, hay que recrearlo de cero, con web_id nuevo y resubiendo imagenes.
 */
router.delete(
  '/:sku',
  asyncHandler(async (req, res) => {
    const { sku } = req.params;

    if (req.query.confirmar !== 'si') {
      return res.status(400).json({
        error: 'Eliminacion no confirmada',
        detalle:
          'El DELETE de Mercately es presuntamente irreversible. Repetir con ?confirmar=si, ' +
          'o usar POST /:sku/desactivar, que es reversible.',
      });
    }

    const webId = await resolverWebIdDeSku(sku);
    const eliminado = await proveedor.eliminar(webId);

    // La respuesta del DELETE es el unico registro de lo que habia: se guarda entera.
    await repo.registrarEvento({
      sku,
      idProveedor: webId,
      operacion: 'ELIMINAR',
      resultado: 'OK',
      peticion: { web_id: webId },
      respuesta: eliminado,
    });
    await repo.registrarExito({
      sku,
      idProveedor: webId,
      hash: null,
      payload: null,
      precio: null,
      stock: null,
      activo: false,
      estado: 'ELIMINADO',
    });

    res.json({ eliminado });
  })
);

export default router;
