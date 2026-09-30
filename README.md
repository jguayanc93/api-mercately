# api-mercateli

Sincroniza el catalogo de productos de SQL Server hacia la tienda de
**Mercately**, y expone una API REST para consultarlo y operarlo a mano.

```
SQL Server (SELECT, solo lectura)
      |
      v
  api-mercateli  --> compara huellas, arma el delta
      |
      v
Mercately (POST / PUT parcial / DELETE)
```

La tabla de productos de SQL Server la alimenta otra fuente: esta API **nunca la
escribe**. Las unicas tablas que escribe son las suyas (`sync_producto`,
`sync_ejecucion`, `sync_evento`).

Las decisiones de diseño y su porque estan en [docs/decisiones.md](docs/decisiones.md).
La transcripcion del API del proveedor, con sus huecos, en
[docs/api-proveedor.md](docs/api-proveedor.md).

---

## Puesta en marcha

```bash
npm install
cp .env.example .env     # y completar
npm run dev
```

1. **Completar `.env`** — credenciales de SQL Server y `PROVIDER_API_KEY`.
2. **Crear las tablas de sincronizacion** — ejecutar [sql/001_tablas_sync.sql](sql/001_tablas_sync.sql)
   sobre la base de destino. No toca `prd0101` ni ninguna tabla del ERP.

   Sus nombres son configurables por `.env`, asi que se pueden renombrar sin
   tocar codigo (si se cambian en el script, hay que cambiarlos aca tambien):

   ```ini
   DB_ESQUEMA=dbo
   DB_TABLA_SYNC_PRODUCTO=tbl01_api_mercately_sync_producto
   DB_TABLA_SYNC_EJECUCION=tbl01_api_mercately_sync_ejecucion
   DB_TABLA_SYNC_EVENTO=tbl01_api_mercately_sync_evento
   ```

   Si falta alguna, el server igual levanta y `GET /api/sync/estado` responde
   503 diciendo cual, en vez de morir con un error de SQL crudo.
3. **Ajustar [src/productos/origen.js](src/productos/origen.js)** — poner la
   consulta real y `ORIGEN_CONFIGURADO = true`. Es el unico archivo que conoce
   el esquema de la tabla de origen.
4. **Mapear las subcategorias** en [config/subcategorias.json](config/subcategorias.json).
   Mercately exige `subcategory_id` para crear y no publica endpoint de
   categorias; `POST /api/sync/subcategorias/descubrir` las extrae del catalogo
   si ya hay productos cargados.

Antes de dejar que toque la tienda:

```bash
curl -X POST "http://localhost:3000/api/sync?simulacion=true"
```

La simulacion lee la BD, compara huellas y arma los deltas, pero **no llama al
proveedor ni escribe nada**. Sirve para ver exactamente que haria la primera
corrida.

---

## Endpoints

### Productos

| Metodo | Ruta | Que hace |
|---|---|---|
| `GET` | `/api/productos?page=1` | Lista el catalogo de Mercately |
| `GET` | `/api/productos/:sku` | Estado en Mercately + estado de sincronizacion |
| `POST` | `/api/productos` | Crea un producto |
| `PUT` | `/api/productos/:sku` | Actualiza (parcial) |
| `POST` | `/api/productos/:sku/desactivar` | Baja logica — **reversible** |
| `POST` | `/api/productos/:sku/reactivar` | Vuelve a publicarlo |
| `DELETE` | `/api/productos/:sku?confirmar=si` | Baja fisica — irreversible |

En `POST` y `PUT` se puede mandar `subcategory_id` (el `web_id`) o
`subcategoria` (el nombre, que se traduce por `config/subcategorias.json`).

### Sincronizacion

| Metodo | Ruta | Que hace |
|---|---|---|
| `POST` | `/api/sync` | Dispara una corrida. `?simulacion=true` para el ensayo |
| `GET` | `/api/sync/estado` | Tablero: productos por estado, cron, ultima corrida |
| `GET` | `/api/sync/ejecuciones` | Historial de corridas |
| `GET` | `/api/sync/eventos/:sku` | Que paso con un SKU, operacion por operacion |
| `GET` | `/api/sync/origen` | Diagnostico: corre la consulta y la muestra normalizada |
| `GET` | `/api/sync/proveedor` | Verifica credenciales contra Mercately |
| `GET` | `/api/sync/subcategorias` | Mapeo actual |
| `POST` | `/api/sync/subcategorias/descubrir` | Extrae los `web_id` del catalogo remoto |
| `POST` | `/api/sync/subcategorias/recargar` | Relee el JSON sin reiniciar |

`GET /health` responde el estado de la BD, del proveedor y del origen.

---

## Como decide que sincronizar

De cada producto se arma el payload de Mercately y se guarda su SHA-256 en
`sync_producto`. En el ciclo siguiente:

| Situacion | Accion |
|---|---|
| La huella no cambio | nada — no se gasta llamada |
| Sin `web_id` registrado | `POST`, y se guarda el `web_id` que devuelve |
| Sin `web_id` pero el SKU ya existe en Mercately | se adopta su `web_id`, no se duplica |
| La huella cambio | `PUT` con **solo los campos que cambiaron** |
| El producto ya no viene de la BD | `PUT {"active": false}` |

El delta se calcula contra el ultimo payload enviado, que queda guardado en
`sync_producto.payload_enviado`. Por eso un cambio de precio manda solo el
precio, y no pisa lo que alguien haya editado a mano en el panel de Mercately.

### Protecciones

- **Una corrida a la vez.** Si la anterior sigue viva, el ciclo del cron se
  saltea en lugar de solaparse.
- **Freno de mano en las bajas.** Si una corrida quisiera desactivar mas del
  `SYNC_MAX_BAJAS_PORCENTAJE` del catalogo publicado (20% por defecto), aborta
  esa fase y lo registra. Protege contra una consulta de origen que falle y
  devuelva pocas filas, lo que apagaria la tienda entera.
- **Nunca se envian `options` ni `variants`.** El `PUT` de Mercately es
  solo-agregar y no hay forma documentada de borrar una variante. El catalogo no
  las usa; si algun dia las usara, hay que reabrir eso antes de tocar el codigo.
- **Las imagenes no se reenvian en el `PUT`.** No esta documentado si
  `image_urls` reemplaza la galeria o agrega. Se controla con
  `SYNC_ENVIAR_IMAGENES_EN_UPDATE`.
- **Reintentos** con backoff exponencial en 429, 5xx y fallos de red, respetando
  `Retry-After`. Los 4xx no se reintentan.
- **Espaciado de llamadas.** Mercately no publica limite de cuota:
  `PROVIDER_MIN_INTERVAL_MS` (200 ms por defecto) marca el ritmo total.

---

## Despliegue con PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs api-mercateli
```

**Una sola instancia, en modo fork.** Con `cluster_mode` cada worker programaria
su propio cron y el catalogo se sincronizaria varias veces en paralelo. Para
escalar horizontalmente habria que sacar antes el cron del proceso web.

---

## Estructura

```
src/
├── server.js              arranque, cron, apagado limpio
├── app.js                 Express, /health, manejo de errores
├── config/
│   ├── env.js             valida el .env y aborta si falta algo
│   └── db.js              pool de SQL Server + helpers parametrizados
├── productos/
│   ├── origen.js          << la consulta a SQL Server. El unico archivo
│   │                         que conoce el esquema de la tabla de origen
│   ├── mapeo.js           producto normalizado -> payload de Mercately
│   └── subcategorias.js   nombre de subcategoria -> web_id
├── proveedor/
│   ├── http.js            api-key, timeout, reintentos, espaciado
│   └── productos.js       las 5 operaciones del API
├── sync/
│   ├── sincronizador.js   el motor: deltas, altas, bajas, contadores
│   └── cron.js            programacion periodica
├── repos/syncRepo.js      sync_producto, sync_ejecucion, sync_evento
├── routes/                productos.js, sync.js
└── utils/                 logger, normalizacion de precios y hashes
```
