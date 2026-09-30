import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { randomUUID } from 'node:crypto';

import { query } from './config/db.js';
import { logger } from './utils/logger.js';
import { proveedorConfigurado } from './config/env.js';
import { ErrorProveedor } from './proveedor/http.js';
import { ORIGEN_CONFIGURADO } from './productos/origen.js';
import rutas from './routes/index.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  // Un id por request para poder seguir el rastro en los logs.
  app.use((req, res, next) => {
    req.id = req.get('x-request-id') ?? randomUUID();
    res.set('x-request-id', req.id);
    req.log = logger.child({ reqId: req.id });

    const inicio = Date.now();
    res.on('finish', () => {
      req.log.info(
        { metodo: req.method, ruta: req.originalUrl, status: res.statusCode, ms: Date.now() - inicio },
        'request'
      );
    });
    next();
  });

  app.get('/health', async (_req, res) => {
    const salud = {
      ok: true,
      uptime: Math.round(process.uptime()),
      db: 'desconocido',
      proveedor: proveedorConfigurado ? 'configurado' : 'sin configurar',
      origen: ORIGEN_CONFIGURADO ? 'configurado' : 'sin configurar',
    };

    try {
      await query('SELECT 1 AS ok');
      salud.db = 'ok';
    } catch (err) {
      salud.ok = false;
      salud.db = 'error';
      salud.dbError = err.message;
    }

    res.status(salud.ok ? 200 : 503).json(salud);
  });

  app.use('/api', rutas);

  app.use((req, res) => {
    res.status(404).json({ error: 'No encontrado', ruta: req.originalUrl });
  });

  // eslint-disable-next-line no-unused-vars -- Express identifica el handler de errores por tener 4 argumentos.
  app.use((err, req, res, _next) => {
    /*
     * Un fallo del proveedor no es un fallo nuestro: se responde 502 y se
     * adjunta lo que dijo Mercately, que es lo unico util para diagnosticar.
     * Los 4xx se dejan pasar tal cual porque describen el pedido, no la falla.
     */
    if (err instanceof ErrorProveedor) {
      const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 502;
      (req.log ?? logger).error({ err, status }, 'Error del proveedor');
      return res.status(status).json({
        error: 'Error al hablar con Mercately',
        detalle: err.message,
        proveedor: { status: err.status, cuerpo: err.cuerpo },
        requestId: req.id,
      });
    }

    const status = err.status ?? err.statusCode ?? 500;
    (req.log ?? logger).error({ err, status }, 'Error no controlado');
    res.status(status).json({
      error: status >= 500 ? 'Error interno' : err.message,
      detalle: err.detalle,
      requestId: req.id,
    });
  });

  return app;
}
