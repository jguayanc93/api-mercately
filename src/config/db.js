import sql from 'mssql';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

const config = {
  server: env.DB_SERVER,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  options: {
    encrypt: env.DB_ENCRYPT,
    trustServerCertificate: env.DB_TRUST_SERVER_CERTIFICATE,
    enableArithAbort: true,
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
  connectionTimeout: 15_000,
  requestTimeout: 60_000,
};

let pool = null;
let conectando = null;

/** Devuelve el pool compartido, abriendolo la primera vez. */
export async function getPool() {
  if (pool?.connected) return pool;

  if (!conectando) {
    conectando = new sql.ConnectionPool(config)
      .connect()
      .then((p) => {
        p.on('error', (err) => logger.error({ err }, 'Error en el pool de SQL Server'));
        pool = p;
        conectando = null;
        logger.info({ server: env.DB_SERVER, database: env.DB_NAME }, 'Conectado a SQL Server');
        return p;
      })
      .catch((err) => {
        conectando = null;
        throw err;
      });
  }

  return conectando;
}

/**
 * Ejecuta una consulta parametrizada. Nunca concatenes valores en el SQL.
 *
 *   query('SELECT * FROM productos WHERE sku = @sku', { sku: 'ABC' })
 *   query('... @precio', { precio: { type: sql.Decimal(18, 4), value: 10.5 } })
 */
export async function query(texto, params = {}) {
  const p = await getPool();
  const request = p.request();

  for (const [nombre, valor] of Object.entries(params)) {
    if (valor !== null && typeof valor === 'object' && 'type' in valor) {
      request.input(nombre, valor.type, valor.value);
    } else {
      request.input(nombre, valor);
    }
  }

  return request.query(texto);
}

/** Igual que query() pero devuelve directamente las filas. */
export async function queryRows(texto, params = {}) {
  const { recordset } = await query(texto, params);
  return recordset ?? [];
}

/** Corre varias operaciones dentro de una transaccion. */
export async function withTransaction(fn) {
  const p = await getPool();
  const trx = new sql.Transaction(p);
  await trx.begin();
  try {
    const resultado = await fn(trx);
    await trx.commit();
    return resultado;
  } catch (err) {
    await trx.rollback().catch(() => {});
    throw err;
  }
}

export async function closePool() {
  if (pool) {
    await pool.close().catch((err) => logger.error({ err }, 'Error cerrando el pool'));
    pool = null;
  }
}

export { sql };
