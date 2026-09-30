import { query, queryRows, sql } from '../config/db.js';
import { env } from '../config/env.js';

/*
 * Nombres de tabla configurables por .env. Se interpolan (SQL no admite
 * parametrizar identificadores), por eso env.js los valida como identificador
 * estricto antes de llegar aca.
 */
const ESQ = env.DB_ESQUEMA;
const T_PRODUCTO = `[${ESQ}].[${env.DB_TABLA_SYNC_PRODUCTO}]`;
const T_EJECUCION = `[${ESQ}].[${env.DB_TABLA_SYNC_EJECUCION}]`;
const T_EVENTO = `[${ESQ}].[${env.DB_TABLA_SYNC_EVENTO}]`;

export const tablas = {
  producto: `${ESQ}.${env.DB_TABLA_SYNC_PRODUCTO}`,
  ejecucion: `${ESQ}.${env.DB_TABLA_SYNC_EJECUCION}`,
  evento: `${ESQ}.${env.DB_TABLA_SYNC_EVENTO}`,
};

/** Los NVARCHAR(MAX) de auditoria no necesitan guardar respuestas gigantes. */
const LIMITE_PAYLOAD = 8000;

function recortar(valor) {
  if (valor === null || valor === undefined) return null;
  const texto = typeof valor === 'string' ? valor : JSON.stringify(valor);
  if (texto === undefined) return null;
  return texto.length > LIMITE_PAYLOAD ? `${texto.slice(0, LIMITE_PAYLOAD)}...[recortado]` : texto;
}

const decimal = (valor) => ({ type: sql.Decimal(18, 4), value: valor ?? null });
const entero = (valor) => ({ type: sql.Int, value: valor ?? null });
const bit = (valor) => ({ type: sql.Bit, value: valor === null || valor === undefined ? null : valor });
const texto = (valor, largo = 100) => ({ type: sql.NVarChar(largo), value: valor ?? null });
const textoLargo = (valor) => ({ type: sql.NVarChar(sql.MAX), value: recortar(valor) });

/* =====================================================================
   sync_producto — estado por producto
   ===================================================================== */

/** Mapa `sku -> estado`, que es como lo consume el sincronizador. */
export async function obtenerEstados() {
  const filas = await queryRows(`
    SELECT sku, id_proveedor, hash_payload, payload_enviado, precio_enviado,
           stock_enviado, activo_enviado, estado, intentos, fecha_sincronizado
      FROM ${T_PRODUCTO}
  `);

  return new Map(
    filas.map((fila) => {
      // El payload viaja como texto; lo devolvemos ya parseado para el delta.
      let payload = null;
      if (fila.payload_enviado) {
        try {
          payload = JSON.parse(fila.payload_enviado);
        } catch {
          payload = null; // fila vieja o corrupta: se trata como "nunca enviado"
        }
      }
      return [fila.sku, { ...fila, payload }];
    })
  );
}

export async function obtenerEstado(sku) {
  const filas = await queryRows(`SELECT * FROM ${T_PRODUCTO} WHERE sku = @sku`, {
    sku: texto(sku),
  });
  return filas[0] ?? null;
}

/**
 * Upsert del estado tras una operacion exitosa.
 *
 * Se usa UPDATE + `IF @@ROWCOUNT = 0` INSERT en lugar de MERGE: para una clave
 * unica simple es equivalente y evita los problemas conocidos de MERGE.
 */
export async function registrarExito({
  sku,
  idProveedor,
  hash,
  payload,
  precio,
  stock,
  activo,
  estado = 'SINCRONIZADO',
}) {
  await query(
    `
    UPDATE ${T_PRODUCTO}
       SET id_proveedor         = COALESCE(@idProveedor, id_proveedor),
           hash_payload         = @hash,
           payload_enviado      = @payload,
           precio_enviado       = @precio,
           stock_enviado        = @stock,
           activo_enviado       = @activo,
           estado               = @estado,
           intentos             = 0,
           ultimo_error         = NULL,
           fecha_ultimo_intento = SYSUTCDATETIME(),
           fecha_sincronizado   = SYSUTCDATETIME(),
           fecha_eliminado      = CASE WHEN @estado = 'ELIMINADO' THEN SYSUTCDATETIME() ELSE fecha_eliminado END
     WHERE sku = @sku;

    IF @@ROWCOUNT = 0
      INSERT INTO ${T_PRODUCTO}
             (sku, id_proveedor, hash_payload, payload_enviado, precio_enviado,
              stock_enviado, activo_enviado, estado, intentos, fecha_creacion,
              fecha_ultimo_intento, fecha_sincronizado)
      VALUES (@sku, @idProveedor, @hash, @payload, @precio,
              @stock, @activo, @estado, 0, SYSUTCDATETIME(),
              SYSUTCDATETIME(), SYSUTCDATETIME());
    `,
    {
      sku: texto(sku),
      idProveedor: texto(idProveedor),
      hash: { type: sql.Char(64), value: hash ?? null },
      payload: {
        type: sql.NVarChar(sql.MAX),
        value: payload === null || payload === undefined ? null : JSON.stringify(payload),
      },
      precio: decimal(precio),
      stock: entero(stock),
      activo: bit(activo),
      estado: texto(estado, 20),
    }
  );
}

/** Deja constancia del fallo y suma un intento, sin tocar la huella enviada. */
export async function registrarFallo({ sku, mensaje }) {
  await query(
    `
    UPDATE ${T_PRODUCTO}
       -- COALESCE porque la columna admite NULL: sin el, NULL + 1 daria NULL
       -- y el contador de intentos se quedaria clavado para siempre.
       SET estado               = 'ERROR',
           intentos             = COALESCE(intentos, 0) + 1,
           ultimo_error         = @mensaje,
           fecha_ultimo_intento = SYSUTCDATETIME()
     WHERE sku = @sku;

    IF @@ROWCOUNT = 0
      INSERT INTO ${T_PRODUCTO}
             (sku, estado, intentos, ultimo_error, fecha_creacion, fecha_ultimo_intento)
      VALUES (@sku, 'ERROR', 1, @mensaje, SYSUTCDATETIME(), SYSUTCDATETIME());
    `,
    { sku: texto(sku), mensaje: textoLargo(mensaje) }
  );
}

/** Adopta el web_id de un producto que ya existia en el proveedor. */
export async function vincularWebId(sku, idProveedor) {
  await query(
    `
    UPDATE ${T_PRODUCTO} SET id_proveedor = @idProveedor WHERE sku = @sku;

    IF @@ROWCOUNT = 0
      INSERT INTO ${T_PRODUCTO} (sku, id_proveedor, estado, intentos, fecha_creacion)
      VALUES (@sku, @idProveedor, 'PENDIENTE', 0, SYSUTCDATETIME());
    `,
    { sku: texto(sku), idProveedor: texto(idProveedor) }
  );
}

/* =====================================================================
   sync_ejecucion — una fila por corrida
   ===================================================================== */

export async function iniciarEjecucion(origen) {
  // Se pasan todos los valores explicitamente en vez de confiar en los DEFAULT
  // de la tabla: las columnas son NOT NULL y si la tabla se creo sin defaults,
  // un INSERT que solo mande `origen` falla.
  const { recordset } = await query(
    `
    INSERT INTO ${T_EJECUCION}
           (origen, estado, fecha_inicio, leidos, creados, actualizados,
            eliminados, sin_cambios, errores)
    OUTPUT INSERTED.id
    VALUES (@origen, 'EN_CURSO', SYSUTCDATETIME(), 0, 0, 0, 0, 0, 0)
    `,
    { origen: texto(origen, 20) }
  );
  return recordset[0].id;
}

export async function cerrarEjecucion(id, { estado, contadores = {}, mensajeError = null }) {
  await query(
    `
    UPDATE ${T_EJECUCION}
       SET estado        = @estado,
           fecha_fin     = SYSUTCDATETIME(),
           duracion_ms   = DATEDIFF(MILLISECOND, fecha_inicio, SYSUTCDATETIME()),
           leidos        = @leidos,
           creados       = @creados,
           actualizados  = @actualizados,
           eliminados    = @eliminados,
           sin_cambios   = @sinCambios,
           errores       = @errores,
           mensaje_error = @mensajeError
     WHERE id = @id
    `,
    {
      id: { type: sql.BigInt, value: id },
      estado: texto(estado, 20),
      leidos: entero(contadores.leidos ?? 0),
      creados: entero(contadores.creados ?? 0),
      actualizados: entero(contadores.actualizados ?? 0),
      eliminados: entero(contadores.eliminados ?? 0),
      sinCambios: entero(contadores.sinCambios ?? 0),
      errores: entero(contadores.errores ?? 0),
      mensajeError: textoLargo(mensajeError),
    }
  );
}

export function ultimasEjecuciones(limite = 20) {
  return queryRows(
    `SELECT TOP (@limite) * FROM ${T_EJECUCION} ORDER BY fecha_inicio DESC`,
    { limite: entero(limite) }
  );
}

/* =====================================================================
   sync_evento — bitacora por operacion
   ===================================================================== */

export async function registrarEvento({
  idEjecucion = null,
  sku,
  idProveedor = null,
  operacion,
  resultado,
  httpStatus = null,
  peticion = null,
  respuesta = null,
  mensajeError = null,
  duracionMs = null,
}) {
  await query(
    `
    INSERT INTO ${T_EVENTO}
           (id_ejecucion, sku, id_proveedor, operacion, resultado, http_status,
            request_payload, response_payload, mensaje_error, duracion_ms, fecha)
    VALUES (@idEjecucion, @sku, @idProveedor, @operacion, @resultado, @httpStatus,
            @peticion, @respuesta, @mensajeError, @duracionMs, SYSUTCDATETIME())
    `,
    {
      idEjecucion: { type: sql.BigInt, value: idEjecucion },
      sku: texto(sku),
      idProveedor: texto(idProveedor),
      operacion: texto(operacion, 20),
      resultado: texto(resultado, 20),
      httpStatus: entero(httpStatus),
      peticion: textoLargo(peticion),
      respuesta: textoLargo(respuesta),
      mensajeError: textoLargo(mensajeError),
      duracionMs: entero(duracionMs),
    }
  );
}

export function eventosDeSku(sku, limite = 50) {
  return queryRows(
    `SELECT TOP (@limite) * FROM ${T_EVENTO} WHERE sku = @sku ORDER BY fecha DESC`,
    { sku: texto(sku), limite: entero(limite) }
  );
}

/* =====================================================================
   Diagnostico y resumen
   ===================================================================== */

/** Verifica que las tres tablas existan, con un mensaje util si falta alguna. */
export async function verificarTablas() {
  const filas = await queryRows(
    `
    SELECT t.name AS tabla
      FROM sys.tables  AS t
      JOIN sys.schemas AS s ON s.schema_id = t.schema_id
     WHERE s.name = @esquema
       AND t.name IN (@producto, @ejecucion, @evento)
    `,
    {
      esquema: texto(ESQ, 128),
      producto: texto(env.DB_TABLA_SYNC_PRODUCTO, 128),
      ejecucion: texto(env.DB_TABLA_SYNC_EJECUCION, 128),
      evento: texto(env.DB_TABLA_SYNC_EVENTO, 128),
    }
  );

  const existen = new Set(filas.map((f) => f.tabla));
  const faltan = [
    env.DB_TABLA_SYNC_PRODUCTO,
    env.DB_TABLA_SYNC_EJECUCION,
    env.DB_TABLA_SYNC_EVENTO,
  ].filter((t) => !existen.has(t));

  return { ok: faltan.length === 0, esquema: ESQ, faltan, tablas };
}

export async function resumen() {
  /*
   * `estado` dice si la ULTIMA operacion salio bien; `activo_enviado` dice si
   * el producto esta publicado o dado de baja. Son cosas distintas: una baja
   * bien aplicada queda SINCRONIZADO con activo_enviado = 0, y sin separarlas
   * el tablero mostraria las bajas mezcladas con los productos a la venta.
   */
  const [porEstado, publicacion, ultima] = await Promise.all([
    queryRows(`SELECT estado, COUNT(*) AS total FROM ${T_PRODUCTO} GROUP BY estado`),
    queryRows(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN id_proveedor IS NULL THEN 1 ELSE 0 END)     AS sin_publicar,
             SUM(CASE WHEN activo_enviado = 1 THEN 1 ELSE 0 END)       AS activos,
             SUM(CASE WHEN activo_enviado = 0 THEN 1 ELSE 0 END)       AS dados_de_baja
        FROM ${T_PRODUCTO}`),
    queryRows(`SELECT TOP 1 * FROM ${T_EJECUCION} ORDER BY fecha_inicio DESC`),
  ]);

  const p = publicacion[0] ?? {};

  return {
    total: p.total ?? 0,
    activos: p.activos ?? 0,
    dadosDeBaja: p.dados_de_baja ?? 0,
    sinPublicar: p.sin_publicar ?? 0,
    porEstado: Object.fromEntries(porEstado.map((f) => [f.estado, f.total])),
    ultimaEjecucion: ultima[0] ?? null,
  };
}
