import { createApp } from './app.js';
import { env, proveedorConfigurado } from './config/env.js';
import { getPool, closePool } from './config/db.js';
import { logger } from './utils/logger.js';
import { cargar as cargarSubcategorias } from './productos/subcategorias.js';
import { verificarTablas } from './repos/syncRepo.js';
import { ORIGEN_CONFIGURADO } from './productos/origen.js';
import { iniciarCron, detenerCron } from './sync/cron.js';

const app = createApp();

// Fallamos temprano si la BD no responde: es preferible a levantar un server roto.
try {
  await getPool();
} catch (err) {
  logger.fatal({ err }, 'No se pudo conectar a SQL Server');
  process.exit(1);
}

await cargarSubcategorias();

// Aviso temprano si faltan las tablas propias: el server igual levanta, para
// poder diagnosticar por /api/sync/estado en vez de morir sin explicacion.
try {
  const tablas = await verificarTablas();
  if (!tablas.ok) {
    logger.warn(
      { faltan: tablas.faltan, esquema: tablas.esquema },
      'Faltan tablas de sincronizacion: ejecutar sql/001_tablas_sync.sql'
    );
  }
} catch (err) {
  logger.error({ err }, 'No se pudieron verificar las tablas de sincronizacion');
}

if (!proveedorConfigurado) {
  logger.warn('PROVIDER_BASE_URL / PROVIDER_API_KEY vacios: la sincronizacion no podra ejecutarse');
}

if (!ORIGEN_CONFIGURADO) {
  logger.warn(
    'src/productos/origen.js todavia tiene la consulta de ejemplo: ' +
      'ajustar SQL_PRODUCTOS y poner ORIGEN_CONFIGURADO en true antes de sincronizar'
  );
}

const server = app.listen(env.PORT, () => {
  logger.info({ puerto: env.PORT, entorno: env.NODE_ENV }, 'API escuchando');
});

/*
 * Si el puerto esta ocupado por otra app del servidor, el proceso muere y PM2
 * lo reintenta en bucle. Sin este mensaje, el log solo muestra un EADDRINUSE
 * pelado y cuesta ver que el problema es de convivencia, no del codigo.
 */
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.fatal(
      { puerto: env.PORT },
      `El puerto ${env.PORT} ya esta en uso por otro proceso. ` +
        'Cambiar PORT en el .env, o liberar el puerto.'
    );
  } else {
    logger.fatal({ err }, 'Error del servidor HTTP');
  }
  process.exit(1);
});

// El cron arranca despues del listen: si la programacion falla, el server sigue
// en pie y se puede diagnosticar por /api/sync/estado.
try {
  iniciarCron();
} catch (err) {
  logger.error({ err }, 'No se pudo programar el cron');
}

async function apagar(senal) {
  logger.info({ senal }, 'Apagando...');
  detenerCron();

  server.close(async () => {
    await closePool();
    process.exit(0);
  });

  // Si algo queda colgado, no esperamos indefinidamente.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException');
  process.exit(1);
});
