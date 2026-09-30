# Despliegue

Guia para poner `api-mercateli` a correr en el servidor con PM2, conviviendo
con las aplicaciones que ya esten ahi.

## Requisitos

- **Node 20 o superior.** El proyecto usa `fetch` nativo y `--env-file`.
  Verificar con `node --version`.
- **PM2** instalado globalmente: `npm install -g pm2`.
- **Acceso de red a SQL Server** desde el servidor donde corre la API. No es el
  mismo acceso que desde la maquina de desarrollo: hay que probarlo.
- **Salida HTTPS hacia `mercately.shop`.**

---

## Pasos

### 1. Clonar e instalar

```bash
git clone <url-del-repositorio> api-mercateli
cd api-mercateli
npm ci --omit=dev
```

`npm ci` en lugar de `npm install`: instala exactamente las versiones del
`package-lock.json`. `--omit=dev` saltea `pino-pretty`, que solo se usa para
colorear los logs en desarrollo.

### 2. Crear el `.env`

**El `.env` no esta en el repositorio** porque lleva la contraseña de SQL Server
y la API key de Mercately. Hay que crearlo en el servidor:

```bash
cp .env.example .env
nano .env
```

Lo que hay que completar:

| Variable | |
|---|---|
| `DB_SERVER`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Credenciales de SQL Server |
| `PROVIDER_API_KEY` | La API key de Mercately |
| `PORT` | **Ver la seccion de convivencia**: no puede chocar con otra app |
| `SYNC_ENABLED` | `true` para encender el cron |

El resto ya viene con valores medidos y probados.

### 3. Verificar antes de levantar

```bash
npm run db:explorar          # conexion a SQL Server
npm run proveedor:probar     # credenciales de Mercately, solo lecturas
```

Si los dos responden, la configuracion esta bien.

### 4. Levantar

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

`pm2 save` graba la lista de procesos para que sobrevivan a un reinicio del
servidor. **Sin esto, la app no vuelve sola.** Si es la primera vez que se usa
PM2 en esa maquina, ademas hace falta `pm2 startup` una sola vez y ejecutar el
comando que imprime.

### 5. Comprobar

```bash
pm2 logs api-mercateli --lines 50
curl http://localhost:3000/health
curl http://localhost:3000/api/sync/estado
```

`/api/sync/estado` tiene que devolver los productos en seguimiento y el cron
como `programado: true`.

---

## Convivencia con otras apps de PM2

### El cron no se mezcla

La sincronizacion usa **`node-cron`, que corre dentro del proceso Node**. No
escribe en el crontab del sistema ni comparte estado con nada. Cada app de PM2
es un proceso aislado con su propio planificador, asi que otro proyecto en el
mismo PM2 no se entera de este cron ni al reves.

Lo que si puede chocar son tres cosas concretas:

### 1. El nombre de la app

`pm2 start` con un nombre que ya existe **reemplaza** la app existente. Antes
del primer despliegue:

```bash
pm2 list
```

Si aparece otra app llamada `api-mercateli`, cambiar `name` en
`ecosystem.config.cjs`.

### 2. El puerto — el choque mas probable

Si otra app ya escucha en el `PORT` configurado, este proceso muere al arrancar
y PM2 entra en bucle de reinicio. El log lo dice explicitamente:

```
El puerto 3000 ya esta en uso por otro proceso.
Cambiar PORT en el .env, o liberar el puerto.
```

Para verificar antes:

```bash
ss -ltnp | grep :3000        # Linux
netstat -ano | findstr :3000 # Windows
```

Si esta ocupado, cambiar `PORT` en el `.env`. Ningun otro archivo depende de
ese valor.

### 3. Una sola instancia

`ecosystem.config.cjs` fija `instances: 1` y `exec_mode: 'fork'` **a proposito**.
Con `cluster_mode` y varias instancias, cada worker programaria su propio cron y
el catalogo se sincronizaria varias veces en paralelo, pisandose entre si.

Si en el futuro hace falta escalar, primero hay que sacar el cron del proceso
web.

---

## Operacion

```bash
pm2 logs api-mercateli          # logs en vivo
pm2 restart api-mercateli       # reiniciar
pm2 stop api-mercateli          # detener (para el cron tambien)
pm2 describe api-mercateli      # estado, memoria, reinicios
```

### Sincronizar a mano

```bash
curl -X POST "http://localhost:3000/api/sync?simulacion=true"   # ensayo, no escribe
curl -X POST "http://localhost:3000/api/sync"                   # de verdad
curl -X POST "http://localhost:3000/api/sync?limite=20"         # solo 20 productos
```

### Ver que paso con un producto

```bash
curl http://localhost:3000/api/sync/eventos/0506-060556
```

### Apagar el cron sin bajar la API

`SYNC_ENABLED=false` en el `.env` y `pm2 restart api-mercateli`. La
sincronizacion manual por endpoint sigue disponible.

---

## Al desplegar una version nueva

```bash
git pull
npm ci --omit=dev
pm2 restart api-mercateli
```

El `.env` del servidor no se toca: no esta en el repositorio.

**Si la version nueva agrega variables al `.env`**, el arranque falla con un
mensaje que dice exactamente cuales faltan. Comparar contra `.env.example`.

---

## Problemas frecuentes

| Sintoma | Causa probable |
|---|---|
| Reinicios en bucle apenas arranca | Puerto ocupado, o falta una variable en el `.env`. Mirar `pm2 logs` |
| `Configuracion invalida en .env` | Falta una variable. El mensaje lista cuales |
| `No se pudo conectar a SQL Server` | El servidor no llega a la base, o las credenciales cambiaron. Probar con `npm run db:explorar` |
| `Faltan tablas de sincronizacion` | Ejecutar `sql/001_tablas_sync.sql` sobre la base |
| La API responde pero no sincroniza | `SYNC_ENABLED=false`. Verificar con `/api/sync/estado` |
| Errores 502 al hablar con Mercately | API key vencida o cambiada. Probar con `npm run proveedor:probar` |
| `subcategorias_sin_mapear` en las incidencias | Aparecio un grupo nuevo en el ERP. Agregarlo en `config/subcategorias.json` |

---

## Que NO va al repositorio

- **`.env`** — credenciales. Cada servidor lleva el suyo.
- **`node_modules/`** — se reconstruye con `npm ci`.
- **`logs/`** — los escribe PM2. La carpeta se versiona vacia con `.gitkeep`
  porque PM2 necesita que exista.

`config/subcategorias.json` **si** va al repositorio: son los `web_id` de las
subcategorias de Mercately, que es configuracion, no un secreto.
