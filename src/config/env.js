import 'dotenv/config';
import { z } from 'zod';

// El .env siempre entrega strings: convertimos "true"/"1" a boolean real.
const bool = (porDefecto) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(porDefecto)
    .transform((v) => v === 'true' || v === '1');

/*
 * Los nombres de tabla no se pueden parametrizar en SQL: se interpolan en la
 * consulta. Por eso se validan como identificador estricto aunque vengan de un
 * archivo de confianza.
 */
const identificadorSql = (porDefecto) =>
  z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'solo letras, digitos y guion bajo')
    .default(porDefecto);

const esquema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // SQL Server
  DB_SERVER: z.string().min(1, 'requerido'),
  DB_PORT: z.coerce.number().int().positive().default(1433),
  DB_NAME: z.string().min(1, 'requerido'),
  DB_USER: z.string().min(1, 'requerido'),
  DB_PASSWORD: z.string().min(1, 'requerido'),
  DB_ENCRYPT: bool('false'),
  DB_TRUST_SERVER_CERTIFICATE: bool('true'),

  // Tablas propias de esta API. La de productos del ERP no figura aca porque
  // es de solo lectura y su consulta vive en src/productos/origen.js.
  DB_ESQUEMA: identificadorSql('dbo'),
  DB_TABLA_SYNC_PRODUCTO: identificadorSql('tbl01_api_mercately_sync_producto'),
  DB_TABLA_SYNC_EJECUCION: identificadorSql('tbl01_api_mercately_sync_ejecucion'),
  DB_TABLA_SYNC_EVENTO: identificadorSql('tbl01_api_mercately_sync_evento'),

  // API del proveedor. Opcionales para poder levantar el server y probar solo la BD;
  // el cliente del proveedor falla con un mensaje claro si estan vacios.
  PROVIDER_BASE_URL: z
    .string()
    .url()
    .or(z.literal(''))
    .default('')
    .transform((v) => v.replace(/\/+$/, '')),
  PROVIDER_API_KEY: z.string().default(''),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // El proveedor no documenta limite de llamadas: espaciamos por precaucion.
  PROVIDER_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(200),
  PROVIDER_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),

  // Sincronizacion
  SYNC_CRON: z.string().min(1).default('*/15 * * * *'),
  SYNC_ENABLED: bool('true'),
  SYNC_CONCURRENCIA: z.coerce.number().int().positive().max(20).default(4),
  // Probado contra el API real: subcategory_id es OPCIONAL, el producto se crea
  // con categoria null. En true, los productos sin subcategoria mapeada se
  // omiten en lugar de publicarse sin categorizar.
  SYNC_EXIGIR_SUBCATEGORIA: bool('false'),
  // El PUT del proveedor no documenta si image_urls reemplaza o agrega: apagado por defecto.
  SYNC_ENVIAR_IMAGENES_EN_UPDATE: bool('false'),
  // Freno de mano: si una corrida quisiera dar de baja mas de este porcentaje
  // del catalogo, se aborta. Protege contra una consulta de origen que falle y
  // devuelva pocas filas, lo que apagaria la tienda entera.
  SYNC_MAX_BAJAS_PORCENTAJE: z.coerce.number().min(0).max(100).default(20),
});

const resultado = esquema.safeParse(process.env);

if (!resultado.success) {
  const detalle = resultado.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`\nConfiguracion invalida en .env:\n${detalle}\n`);
  process.exit(1);
}

export const env = resultado.data;
export const isProd = env.NODE_ENV === 'production';
export const proveedorConfigurado = Boolean(env.PROVIDER_BASE_URL && env.PROVIDER_API_KEY);
