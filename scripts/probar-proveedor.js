/*
 * Prueba la conexion con Mercately y resuelve las dudas que la documentacion
 * del proveedor deja abiertas. Solo hace lecturas: no crea, no modifica, no
 * borra nada.
 *
 *   npm run proveedor:probar
 */
import { env, proveedorConfigurado } from '../src/config/env.js';
import { pedir } from '../src/proveedor/http.js';
import { listarPagina } from '../src/proveedor/productos.js';

function titulo(texto) {
  console.log(`\n${'='.repeat(60)}\n${texto}\n${'='.repeat(60)}`);
}

if (!proveedorConfigurado) {
  console.error('\nFalta PROVIDER_API_KEY en el .env\n');
  process.exit(1);
}

titulo('1. Credenciales y conectividad');
console.log(`Base: ${env.PROVIDER_BASE_URL}`);

let primeraPagina;
try {
  primeraPagina = await listarPagina(1);
  console.log(`OK - ${primeraPagina.productos.length} productos en la pagina 1`);
  console.log(`     total_pages = ${primeraPagina.totalPaginas}`);
} catch (err) {
  console.error(`FALLA - ${err.message}`);
  if (err.cuerpo) console.error('Respuesta:', JSON.stringify(err.cuerpo));
  process.exit(1);
}

const { productos } = primeraPagina;

titulo('2. Subcategorias presentes en el catalogo');
if (productos.length === 0) {
  console.log('El catalogo esta vacio: no hay subcategorias que extraer.');
  console.log('Hay que conseguir los web_id cargando al menos un producto a mano');
  console.log('desde el panel de Mercately, o viendolos en la URL del panel.');
} else {
  const vistas = new Map();
  for (const p of productos) {
    if (p?.subcategory?.web_id) {
      vistas.set(p.subcategory.web_id, {
        subcategoria: p.subcategory.name,
        categoria: p.category?.name ?? null,
      });
    }
  }
  for (const [webId, info] of vistas) {
    console.log(`  "${info.subcategoria}": "${webId}"   (categoria: ${info.categoria})`);
  }
  console.log('\nPara config/subcategorias.json:');
  console.log(
    JSON.stringify(
      Object.fromEntries([...vistas].map(([webId, info]) => [info.subcategoria, webId])),
      null,
      2
    )
  );
}

titulo('3. GET /products/:id_or_sku — la ruta o el query?');
console.log('La documentacion deja ":id_or_sku" literal en la ruta Y manda web_id/sku');
console.log('por query. Probamos las tres formas para ver cual implementaron.\n');

if (productos.length === 0) {
  console.log('Sin productos en el catalogo no se puede probar. Repetir cuando haya al menos uno.');
} else {
  const ejemplo = productos[0];
  console.log(`Producto de prueba: web_id=${ejemplo.web_id}  sku=${ejemplo.sku}\n`);

  const intentos = [
    {
      etiqueta: 'valor en la RUTA',
      ruta: `/products/${encodeURIComponent(ejemplo.web_id)}`,
      query: undefined,
    },
    {
      etiqueta: 'valor en el QUERY',
      ruta: '/products/:id_or_sku',
      query: { web_id: ejemplo.web_id },
    },
    {
      etiqueta: 'en la RUTA y el QUERY (lo que hace nuestro cliente)',
      ruta: `/products/${encodeURIComponent(ejemplo.web_id)}`,
      query: { web_id: ejemplo.web_id },
    },
    {
      etiqueta: 'por SKU en la ruta',
      ruta: `/products/${encodeURIComponent(ejemplo.sku)}`,
      query: { sku: ejemplo.sku },
    },
  ];

  for (const intento of intentos) {
    try {
      const { cuerpo, status } = await pedir('GET', intento.ruta, { query: intento.query });
      const devolvio = cuerpo?.web_id ?? cuerpo?.product?.web_id ?? '(sin web_id)';
      const correcto = devolvio === ejemplo.web_id;
      console.log(`  ${correcto ? 'OK   ' : 'RARO '} ${intento.etiqueta}`);
      console.log(`         HTTP ${status}, devolvio web_id=${devolvio}`);
    } catch (err) {
      console.log(`  FALLA ${intento.etiqueta}`);
      console.log(`         ${err.message}`);
    }
  }
}

titulo('4. Tamaño de pagina');
if (primeraPagina.totalPaginas > 1) {
  const segunda = await listarPagina(2);
  console.log(`Pagina 1: ${productos.length} productos`);
  console.log(`Pagina 2: ${segunda.productos.length} productos`);
  console.log(`Estimado del catalogo: ~${productos.length * primeraPagina.totalPaginas} productos`);
} else {
  console.log(`Una sola pagina, ${productos.length} productos. Sin datos para inferir el tamaño.`);
}

console.log('\nListo. Ninguna de estas llamadas modifico nada.\n');
