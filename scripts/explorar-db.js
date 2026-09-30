/*
 * Explora la base de SQL Server sin tocar nada: solo SELECT.
 *
 *   npm run db:explorar                 -> lista las tablas con su cantidad de filas
 *   npm run db:explorar productos       -> columnas y filas de ejemplo de esa tabla
 *   npm run db:explorar dbo.productos   -> idem, con esquema explicito
 */
import { queryRows, closePool } from '../src/config/db.js';
import { env } from '../src/config/env.js';

const argumento = process.argv[2];

async function listarTablas() {
  const filas = await queryRows(`
    SELECT s.name AS esquema,
           t.name AS tabla,
           SUM(CASE WHEN p.index_id IN (0, 1) THEN p.rows ELSE 0 END) AS filas
      FROM sys.tables  AS t
      JOIN sys.schemas AS s ON s.schema_id = t.schema_id
      JOIN sys.partitions AS p ON p.object_id = t.object_id
     GROUP BY s.name, t.name
     ORDER BY filas DESC, s.name, t.name
  `);

  console.log(`\nBase: ${env.DB_NAME} en ${env.DB_SERVER}`);
  console.log(`${filas.length} tablas\n`);
  console.log('FILAS'.padStart(10), ' TABLA');
  console.log('-'.repeat(60));
  for (const f of filas) {
    console.log(String(f.filas).padStart(10), ` ${f.esquema}.${f.tabla}`);
  }
  console.log('\nPara ver una tabla:  npm run db:explorar -- <nombre_de_tabla>\n');
}

async function describirTabla(nombre) {
  const [esquema, tabla] = nombre.includes('.') ? nombre.split('.') : ['dbo', nombre];

  const columnas = await queryRows(
    `
    SELECT c.COLUMN_NAME     AS columna,
           c.DATA_TYPE       AS tipo,
           c.CHARACTER_MAXIMUM_LENGTH AS largo,
           c.NUMERIC_PRECISION AS precision_,
           c.NUMERIC_SCALE   AS escala,
           c.IS_NULLABLE     AS nulable
      FROM INFORMATION_SCHEMA.COLUMNS AS c
     WHERE c.TABLE_SCHEMA = @esquema AND c.TABLE_NAME = @tabla
     ORDER BY c.ORDINAL_POSITION
  `,
    { esquema, tabla }
  );

  if (columnas.length === 0) {
    console.error(`\nNo existe la tabla ${esquema}.${tabla}\n`);
    return;
  }

  console.log(`\n=== ${esquema}.${tabla} ===\n`);
  console.log('COLUMNA'.padEnd(32), 'TIPO'.padEnd(20), 'NULL');
  console.log('-'.repeat(62));

  for (const c of columnas) {
    let tipo = c.tipo;
    if (c.largo) tipo += `(${c.largo === -1 ? 'MAX' : c.largo})`;
    else if (c.escala !== null && c.escala !== undefined) tipo += `(${c.precision_},${c.escala})`;
    console.log(c.columna.padEnd(32), tipo.padEnd(20), c.nulable);
  }

  // Los corchetes protegen nombres con espacios o palabras reservadas.
  const muestra = await queryRows(`SELECT TOP 3 * FROM [${esquema}].[${tabla}]`);
  console.log(`\n--- ${muestra.length} filas de ejemplo ---\n`);
  for (const fila of muestra) console.log(JSON.stringify(fila, null, 2));
  console.log();
}

try {
  if (argumento) await describirTabla(argumento);
  else await listarTablas();
} catch (err) {
  console.error('\nError:', err.message, '\n');
  process.exitCode = 1;
} finally {
  await closePool();
}
