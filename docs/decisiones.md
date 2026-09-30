# Decisiones de diseño

## Direccion del flujo

**SQL Server manda, Mercately obedece.**

```
SQL Server (SELECT, solo lectura)
      |
      v
  Esta API  --> detecta que cambio (hash)
      |
      v
Mercately (POST / PUT / DELETE)
```

La tabla de productos de SQL Server la alimenta otra fuente. Esta API **nunca
la escribe**: solo la consulta. Las unicas tablas que escribe son las suyas
(`sync_producto`, `sync_ejecucion`, `sync_evento`).

---

## Decisiones tomadas

### 1. Productos simples, sin variantes

El catalogo no maneja tallas ni colores: un SKU es un producto con un precio y
un stock.

**Consecuencia:** el sincronizador **nunca envia `options` ni `variants`**. Con
eso desaparece por completo el riesgo de duplicacion acumulativa que tiene el
`PUT` del proveedor (es solo-agregar y no hay forma de borrar una variante).
Si algun dia aparecen variantes, hay que reabrir esas preguntas antes de
tocar el codigo.

### 2. Baja logica con `active: false`, no `DELETE`

Cuando un producto deja de estar disponible en la BD se envia
`PUT {"product":{"active":false}}`.

**Por que:** es reversible y conserva el `web_id`, las imagenes y el historial.
El `DELETE` es presuntamente irreversible: si el producto reaparece habria que
recrearlo de cero, con `web_id` nuevo y resubiendo imagenes.

El `DELETE` igual se implementa, pero **solo se dispara a mano** desde un
endpoint de esta API. El cron nunca borra.

### 3. Sincronizacion completa

El ciclo automatico hace las tres cosas:

| Situacion | Accion |
|---|---|
| Producto en la BD sin `web_id` registrado | `POST` — crear y guardar el `web_id` |
| Producto con cambios (precio, stock, titulo...) | `PUT` parcial, solo los campos que cambiaron |
| Producto sin cambios | nada — no se gasta llamada |
| Producto que dejo de estar disponible | `PUT {"active": false}` |
| Producto que vuelve a estar disponible | `PUT {"active": true}` |

### 4. Catalogo de Mercately inicialmente vacio

La primera corrida crea todo desde cero y persiste el `web_id` que devuelve
cada `POST`.

**Salvedad importante:** aun asi, la primera corrida debe **emparejar por SKU**
contra `GET /products` antes de crear. Si el proceso se corta a la mitad y se
relanza, sin ese emparejamiento se duplicaria todo lo ya creado. El costo es
una pasada de lectura; el beneficio es que el sincronizador se vuelve seguro
de reintentar.

---

## Reglas derivadas

1. **Nunca reenviar el producto entero en un `PUT`.** Solo los campos que
   cambiaron, para no pisar lo que alguien edite a mano en el panel de
   Mercately.
2. **Normalizar los precios a decimal de escala fija antes de comparar.** El
   proveedor los escribe como numero y los devuelve como string; sin
   normalizar, `"20.0"` vs `20` se detecta como cambio y se dispara un `PUT`
   inutil por producto en cada ciclo.
3. **El `web_id` es el unico identificador estable.** El `sku` es modificable
   via `PUT` del lado del proveedor.
4. **Toda operacion contra el proveedor se registra en `sync_evento`**, con su
   request, su response y su duracion.

---

## Mapeo de campos: `prd0101` -> Mercately

Origen: `bdnava01`, tabla `prd0101` (20.030 filas; 1.086 pasan el filtro).

| Mercately | Origen | Notas |
|---|---|---|
| `sku` | `a.codi` | Unico en los 1.086. `Usr_001` (part_number) **no** sirve: 1.008 distintos y 5 vacios |
| `title` | `a.descr` | 15 a 80 caracteres |
| `description` | `a.obse` limpio, si no `a.descr` | Ver abajo |
| `price` | `a.vvus` | Dolares, **sin IGV y sin descuento** |
| `quantity` | `a.stoc - a.svta - a.pedi` | El disponible real, no `stoc` |
| `active` | siempre `true` | Lo define el `WHERE`, no una columna |
| `subcategory_id` | `LEFT(a.codi,2)` via `config/subcategorias.json` | Codigo de familia de `tbl01fam` |
| `image_urls` | — | Pendiente |

### Por que el stock es `stoc - svta - pedi`

Es la misma formula que usa el `WHERE` para decidir si el producto se muestra:
filtrar por una cosa y publicar otra seria incoherente. **256 de los 1.086
productos (24%) tienen un `stoc` mayor que su disponible real.** El peor caso
visto es `0102-010292`, con `stoc = 53` y disponible `3`: publicar `stoc`
ofreceria 50 unidades inexistentes.

### Por que el precio es `vvus`

Decision del negocio: precio de lista, en dolares, sin IGV y sin descuento.

La tabla tambien tiene el precio con IGV ya calculado (`pvus = vvus * 1.18` en
1.083 de 1.086; los otros 3 tienen `pvus = 0`) y el monto en `igvus`, por si
alguna vez se publica el precio al consumidor final.

El descuento de `Dtl_Dscto_Marca_Tc` **no se aplica**: depende de la categoria
del cliente (hay 19, de A a S mas Z, con topes de 0% a 15% segun la marca) y
Mercately publica un unico precio por producto. El descuento se negocia fuera
de la tienda. El `LEFT JOIN` queda en la consulta como dato informativo.

### Por que la descripcion se limpia

`obse` mezcla tres formatos: vacio (363), texto plano con saltos de linea (551)
y HTML suelto (172, de los cuales 78 con `<table>`). Mercately devuelve sus
descripciones en texto plano, asi que mandar HTML crudo se veria roto si su
tienda no lo renderiza; texto limpio se ve bien en ambos casos.

`src/utils/texto.js` quita los tags, decodifica las entidades (incluidos los
simbolos de ficha tecnica: `±`, `−`, `≈`, `×`, `°`) y convierte los tabuladores
de los volcados de especificaciones en `: `, de modo que `Color\tNegro` queda
como `Color: Negro`. Donde no queda nada usable, se cae a `descr`.

### Verificado contra los datos reales

Los 1.086 productos pasan: 0 descartados, 0 con HTML sin limpiar, 0 con
entidades sin decodificar, 0 SKU duplicados, 0 precios nulos, 0 stocks en cero.
Descripciones de 9 a 3.195 caracteres, mediana 69.

---

## Estado actual

**Catalogo completo publicado y categorizado. Cero errores.**

| | |
|---|---|
| En seguimiento | 1.115 |
| Activos en la tienda | 1.104 |
| Dados de baja (`active: false`) | 11 |
| Sin publicar | 0 |
| Subcategoria asignada | los 40 grupos del ERP, sin huecos |
| Cron | **apagado** (`SYNC_ENABLED=false`) |

Verificado contra el entorno real:

- **Los productos llegan identicos**: title, description, price, quantity y
  active coinciden campo por campo con lo enviado.
- **Las descripciones largas no se truncan**: 3.195 caracteres enviados,
  3.195 recibidos. Mercately no impone limite, al menos hasta ese tamaño.
- **Una corrida sin cambios no gasta ni una llamada.** En la carga inicial se
  midio: 1.114 llamadas para 18 altas + 1.086 actualizaciones + 10 bajas. Exacto.
- **La formula de stock evita sobreventa.** `0109-010007` y `0109-010020`
  estaban publicados con 17 y 18 unidades y salieron del filtro sin que bajara
  el stock fisico: se comprometieron en ventas o pedidos. Publicando `stoc` a
  secas se habrian ofrecido unidades inexistentes.
- **El catalogo respira.** Entre la simulacion y la corrida real el origen paso
  de 1.083 a 1.104 productos. 194 tuvieron movimiento en un solo dia.

Ritmos medidos: 4,7 altas por segundo; la carga completa de 1.078 productos
tardo 3,8 minutos, y la asignacion de subcategorias a 1.086, cuatro minutos.

### Categorizacion

Las 9 familias del ERP (`LEFT(codi,2)`) coinciden con las 9 **categorias** de
Mercately, y los 40 grupos de `LEFT(codi,4)` con sus **subcategorias**. Como el
producto solo recibe `subcategory_id` y la categoria se deduce de ahi, el mapeo
vive en `config/subcategorias.json` con el grupo de 4 digitos como clave.

Dos casos se resolvieron por decision del negocio, no por dato del ERP:

- `0101` (soportes VESA para mini PC) va a **ACCESORIOS > otros**.
- `1005` mezcla 4 routers Linksys y 1 access point Tenda: va entero a
  **CONECTIVIDAD > access point**. Separarlos exigiria una regla sobre el
  titulo del producto, porque el ERP no los distingue.

Queda **CONECTIVIDAD > routers** sin uso por esa decision, y
**ALMACENAMIENTO EXTERNO > almacenamiento interno**, que el negocio identifico
como creada por error: los discos internos son parte de PARTES Y PIEZAS.

---

## Pendientes del lado del negocio

- [x] ~~Consulta SQL de los productos~~ — mapeada y verificada
- [x] ~~`web_id` de las subcategorias~~ — resueltos via `GET /categories`
- [x] ~~API key~~ — configurada y probada
- [x] ~~Carga inicial del catalogo~~ — 1.104 productos publicados y categorizados
- [ ] **Encender el cron** (`SYNC_ENABLED=true`), junto con el despliegue. Ya
      esta configurado en **cada 3 minutos** (`*/3 * * * *`). Medido: un ciclo
      sin cambios cuesta 0,21s de computo mas 107ms de SQL, o sea unos 2,5
      minutos de trabajo repartidos en 480 ciclos diarios. La cantidad de
      llamadas a Mercately no depende de la frecuencia: cada producto que
      cambia genera una, se mire cada 3 o cada 60 minutos.
- [ ] **Purga de `sync_evento`**. Crece una fila por llamada al proveedor:
      ~121 cambios diarios dan unas 44.000 filas al año. No molesta por varios
      años, pero conviene definir en algun momento cuanto historial conservar.
- [ ] **Imagenes**: `rutaimage` trae el nombre del archivo en 825 de 1.086
      productos (ej. `Achpk4u14la.Jpg`). Falta la URL base publica donde se
      sirven para poder mandarlas en `image_urls`.
- [ ] Borrar del panel **ALMACENAMIENTO EXTERNO > almacenamiento interno**,
      identificada como creada por error. No la usa ningun grupo, asi que
      borrarla no afecta al sincronizador.
- [ ] Despliegue con PM2 (`ecosystem.config.cjs` ya esta listo).
