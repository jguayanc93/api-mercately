# API del proveedor — Mercately

> Documentacion entregada por el proveedor, transcrita por partes.
> Estado: **las 5 operaciones estan documentadas.** Quedan huecos que el
> proveedor no cubre — ver "Pendiente de confirmar" al final.

- **Base URL:** `https://mercately.shop/api/v1`
- **Autenticacion:** header `api-key: <API_KEY>` (no es Bearer)

---

## 1. Operaciones

| Metodo | Ruta | Proposito |
|---|---|---|
| `GET` | `/api/v1/products` | Listar productos (paginado) |
| `POST` | `/api/v1/products` | Crear producto |
| `GET` | `/api/v1/products/:id_or_sku` | Obtener uno por `web_id` **o** por SKU |
| `PUT` | `/api/v1/products/:web_id` | Actualizar producto |
| `DELETE` | `/api/v1/products/:web_id` | Eliminar producto |
| `GET` | `/api/v1/categories` | **Arbol de categorias y subcategorias** — no figuraba en la documentacion entregada |

---

## 2. `GET /api/v1/products`

### Query

| Parametro | Tipo | Default | Notas |
|---|---|---|---|
| `page` | integer | `1` | Pagina a consultar |

No hay parametro documentado de tamaño de pagina: el proveedor fija cuantos
productos entran por pagina.

### Respuesta

```json
{
  "products": [ /* ver esquema abajo */ ],
  "total_pages": 4
}
```

Para recorrer el catalogo completo: pedir `page=1`, leer `total_pages` y
seguir hasta agotarlo.

### Esquema de producto (lectura)

| Campo | Tipo | Notas |
|---|---|---|
| `web_id` | string | **Id del proveedor.** Necesario para `PUT` y `DELETE` |
| `title` | string | Nombre |
| `description` | string | |
| `quantity` | integer | Stock |
| `price` | **string** | `"39.99"` — llega como texto, no numero |
| `active` | boolean | |
| `url` | string \| null | |
| `sku` | string | Nuestra clave de negocio |
| `wholesale_price` | **string** | `"20.0"` — precio mayorista, tambien texto |
| `images` | string[] | URLs en CloudFront ya alojadas por el proveedor |
| `category` | objeto | `{ name, web_id }` |
| `subcategory` | objeto | `{ name, web_id }` |
| `product_variants` | array | Ejes de variacion — ver abajo |
| `product_variant_combinations` | array | Combinaciones vendibles — ver abajo |

### Variantes (lectura)

`product_variants[]` son los **ejes** (Color, Talla):

```json
{ "name": "Color", "web_id": "pv123abc",
  "product_variant_options": [ { "name": "Negro", "web_id": "BEYaSU7yTH" } ] }
```

`product_variant_combinations[]` son las **combinaciones vendibles**, y cada una
tiene precio, stock y SKU propios:

```json
{ "web_id": "xa6d2qprcI", "name": "Negro/S", "price": "45.86",
  "wholesale_price": "22.94", "sku": "CAM-GRA-010-NEGRO-S", "quantity": 8,
  "variant_option_web_ids": ["BEYaSU7yTH", "nCbIHF5EGT"],
  "image": "", "variant_url": null }
```

`variant_option_web_ids` referencia los `web_id` de las opciones que componen
la combinacion.

---

## 3. `POST /api/v1/products`

`operationId: createProduct`. Header extra: `Content-Type: application/json`.

### Cuerpo

El payload va **envuelto en `product`**:

```json
{
  "product": {
    "title": "string",
    "description": "string",
    "sku": "string",
    "quantity": 0,
    "active": true,
    "price": 0,
    "subcategory_id": "string",
    "image_urls": ["string"],
    "options":  [ { "name": "string", "values": ["string"] } ],
    "variants": [ {
      "price": 0, "wholesale_price": 0, "sku": "string", "quantity": 0,
      "image": "string", "variant_url": "string",
      "option1": "string", "option2": "string", "option3": "string"
    } ]
  }
}
```

| Campo | Tipo | Notas |
|---|---|---|
| `price` | **number** | En la escritura es numero; en la lectura vuelve como string |
| `subcategory_id` | string | El `web_id` de la subcategoria |
| `image_urls` | string[] | URLs **publicas**; el proveedor las descarga y las re-aloja |
| `options` | array | **Maximo 3.** Los ejes de variacion |
| `variants` | array | Las combinaciones vendibles |

### `options` y `variants`

Las `options` declaran los ejes y sus valores posibles; las `variants` son el
producto cartesiano que uno elige publicar. La variante referencia los valores
**por nombre** (`option1`, `option2`, `option3`), no por id — posicionalmente
segun el orden del array `options`.

```json
"options": [
  { "name": "Talla", "values": ["SM", "LG", "XL", "MD"] },
  { "name": "Color", "values": ["Red", "Blue"] }
],
"variants": [
  { "price": 12, "wholesale_price": 10, "sku": "VAR-001", "option1": "SM", "option2": "Red" },
  { "price": 14, "wholesale_price": 10, "sku": "VAR-002", "option1": "LG", "option2": "Red" },
  { "price": 25, "wholesale_price": 13, "sku": "VAR-003", "option1": "XL", "option2": "Blue" }
]
```

`option1` corresponde a `options[0]`, `option2` a `options[1]`, `option3` a
`options[2]`. El limite de 3 opciones coincide con que solo existan esos tres
campos.

### Respuesta

```json
{
  "message": "Producto creado con éxito",
  "product": { "web_id": "FzOWVvUwbC", "...": "producto completo, mismo esquema que el GET" }
}
```

**El `POST` devuelve el `web_id`**, tanto del producto como de cada variante,
opcion y combinacion. Eso es lo que hay que persistir en `sync_producto`.

---

## 4. `GET /api/v1/products/:id_or_sku`

Obtiene un producto puntual.

### Query

| Parametro | Tipo | Notas |
|---|---|---|
| `web_id` | string | El `web_id` del producto |
| `sku` | string | El SKU del producto |

> **La documentacion se contradice a si misma.** El ejemplo del proveedor deja
> el literal `:id_or_sku` en la ruta *y ademas* manda `web_id` y `sku` como
> query string:
>
> ```
> https://mercately.shop/api/v1/products/:id_or_sku?web_id=string&sku=string
> ```
>
> No puede ser correcto tal cual. Las lecturas posibles son: (a) el valor va en
> la ruta y el query es ruido del generador de docs, o (b) el identificador va
> en el query y el segmento de ruta quedo sin reemplazar. Hay que probarlo
> contra el API real antes de fijar el cliente. Tampoco esta claro que pasa si
> se mandan `web_id` y `sku` a la vez.

### Respuesta

Devuelve el producto **sin envoltorio** — no hay `{ product: ... }` alrededor:

```json
{
  "web_id": "CRasFSldo7",
  "title": "Camiseta Gráfica Premium",
  "quantity": 85,
  "price": "39.99",
  "sku": "CAM-GRA-010",
  "subcategory": { "web_id": "GETPvRKnBD", "name": "Camisetas", "description": "",
                   "products_count": 5, "active_products_count": 2 },
  "category":    { "web_id": "ljsJpi0fTR", "name": "Ropa", "description": "",
                   "products_count": 11, "active_products_count": 6 },
  "product_variants": [ "..." ],
  "product_variant_combinations": [ "..." ]
}
```

Mismo esquema que el listado, salvo que `category` y `subcategory` vienen
enriquecidas con `description`, `products_count` y `active_products_count`.

---

## 5. `PUT /api/v1/products/{web_id}`

`operationId: updateProduct`. Mismo cuerpo que el `POST` (envuelto en `product`,
maximo 3 opciones).

### Actualizacion parcial — soportada

Se pueden enviar solo los campos que cambiaron. Reglas que declara el proveedor:

| Que se envia | Que pasa con las variantes existentes |
|---|---|
| Ni `options` ni `variants` | Se preservan |
| `options: []` o `variants: []` | Se preservan (el array vacio **no** borra) |
| `options` / `variants` con contenido nuevo | Se **agregan** a las existentes, sin borrar las anteriores |

Actualizar solo precio y titulo:

```json
{ "product": { "title": "Nuevo título", "price": 29.99 } }
```

Agregar una opcion sin tocar las existentes:

```json
{ "product": { "options": [ { "name": "Material", "values": ["Algodón", "Poliéster"] } ] } }
```

Agregar una combinacion nueva — notese que `options` repite los valores ya
existentes y suma el nuevo:

```json
{ "product": {
    "options":  [ { "name": "Talla", "values": ["SM", "LG", "XL", "XXL"] } ],
    "variants": [ { "option1": "XXL", "sku": "VAR-XXL", "price": 35, "quantity": 10 } ]
} }
```

### Respuesta

```json
{ "message": "Producto actualizado con éxito", "product": { "...": "producto completo" } }
```

---

## 6. `DELETE /api/v1/products/{web_id}`

Sin cuerpo y sin `Content-Type`: solo el header `api-key`.

### Respuesta

```json
{
  "message": "Producto eliminado con éxito",
  "product": {
    "web_id": "tUCJZrCUs5",
    "title": "Abrigo borrego",
    "quantity": 41,
    "price": "8.0",
    "active": true,
    "sku": "AB.577",
    "wholesale_price": "6.0",
    "images": ["...", "...", "..."],
    "subcategory": { "name": "Abrigos", "web_id": "EM5FJCF7sY" },
    "category": { "name": "Abrigos y chaquetas", "web_id": "maFDOHylFB" }
  }
}
```

Devuelve el producto completo tal como estaba. Sirve como respaldo de auditoria:
conviene volcarlo integro en `sync_evento.response_payload`, porque es el unico
registro de lo que se borro.

Dos detalles del ejemplo:

- El producto devuelto trae `active: true` y `quantity: 41`. Es una foto del
  estado **previo** al borrado, no del resultado, asi que la respuesta no dice
  si la baja fue fisica o logica.
- **No aparecen `product_variants` ni `product_variant_combinations`** — las
  claves estan ausentes, no vacias. Puede ser que el producto de ejemplo no
  tuviera variantes, o que el `DELETE` no las devuelva. Sin confirmar.

---

## 7. `GET /api/v1/categories`

**No estaba en la documentacion que entrego el proveedor**, pero existe. Es lo
que resuelve el problema de conseguir los `web_id` de subcategoria: los
devuelve todos, incluso los de subcategorias vacias, que no aparecen por
ningun otro lado.

### Query

| Parametro | Tipo | Default |
|---|---|---|
| `page` | integer | `1` |

### Respuesta

```json
{
  "categories": [
    {
      "web_id": "QCp3UU2t8X",
      "name": "SUMINISTROS",
      "description": "productos que se consumen, reemplazan o utilizan periodicamente",
      "products_count": 0,
      "order": 2,
      "subcategories": [
        { "web_id": "3T3Veb7Xtl", "name": "tinta",  "description": "", "products_count": 0, "order": 3 },
        { "web_id": "lroLDaFzWE", "name": "toner",  "description": "", "products_count": 0, "order": 4 }
      ]
    }
  ],
  "total_pages": 1
}
```

Las subcategorias vienen anidadas dentro de su categoria. El producto solo
recibe `subcategory_id`: la categoria padre la deduce Mercately.

**Ojo con los nombres repetidos entre ramas**: `almacenamiento interno` existe
tanto en PARTES Y PIEZAS DE COMPUTADORA como en ALMACENAMIENTO EXTERNO, con
`web_id` distintos. Buscar por nombre sin acotar la categoria da resultados
ambiguos.

---

## Observaciones tecnicas

1. **Asimetria escritura/lectura en los precios.** Se envia `price: 12` (numero)
   y vuelve `"price": "1.5"` (string). Hay que normalizar a decimal con escala
   fija antes de comparar o hashear; si no, `"20.0"` vs `20` se detecta como
   cambio inexistente y disparamos un `PUT` por producto en cada ciclo del cron.
2. **Asimetria en las variantes.** Se crean por **nombre** (`option1: "SM"`) y
   vuelven por **`web_id`** (`variant_option_web_ids`). Para reconciliar una
   combinacion local con la remota hay que mapear nombre → `web_id` usando
   `product_variants[].product_variant_options[]` de la respuesta.
3. **El stock y el precio reales viven en la combinacion**, no en el producto,
   cuando el producto tiene variantes.
4. **`subcategory_id` es el unico vinculo de categorizacion en la escritura.**
   Se manda solo la subcategoria; la categoria padre la deduce el proveedor.
   No hay endpoint documentado para listar subcategorias y obtener sus `web_id`
   — **esto bloquea la creacion de productos.**
5. **`image_urls` exige URLs publicas alcanzables por el proveedor.** No se
   suben binarios: ellos descargan de la URL y re-alojan en su CloudFront. Las
   imagenes de nuestros productos tienen que estar publicadas en algun lado.
6. **`wholesale_price` solo existe a nivel variante en la escritura**, pero se
   lee a nivel producto. Un producto sin variantes aparentemente no puede
   fijar su precio mayorista al crearlo.
7. **Los ejemplos de la documentacion son inconsistentes entre si** (el request
   crea una camiseta con Talla/Color y el response devuelve subcategoria
   "Alambricos" / categoria "Tecnologia"; el precio del producto es `"1.5"` y
   el de sus combinaciones `"33.0"`). Los valores de ejemplo no son fiables:
   sirve la forma, no el contenido.
8. **No hace falta `node-fetch`.** Node 24 trae `fetch` nativo.
9. `GET /:id_or_sku` acepta SKU: es la via de recuperacion si perdemos un
   `web_id`, en lugar de recrear el producto y duplicarlo.
10. **Cada endpoint envuelve la respuesta distinto.** `GET /products` devuelve
    `{ products, total_pages }`; `POST` devuelve `{ message, product }`;
    `GET /:id_or_sku` devuelve el producto pelado. El cliente tiene que
    desenvolver caso por caso en lugar de asumir una forma comun.
11. **`GET /categories` existe aunque no este documentado.** Devuelve el arbol
    completo con los `web_id` de categorias y subcategorias, incluidas las
    vacias. Resuelve de raiz el problema de la categorizacion, que sin el
    obligaba a sacar los ids a mano del panel.
12. **`subcategory_id` es opcional en el `POST`.** Probado: el producto se crea
    con `category` y `subcategory` en `null`. Sirve para publicar primero y
    categorizar despues con un `PUT` parcial de un solo campo.
13. **Mercately pagina de a 20** en `GET /products`. No esta documentado ni se
    puede cambiar: se midio con 1.088 productos repartidos en 55 paginas.
    Importa para elegir entre releer el catalogo o preguntar SKU por SKU.
14. **`POST` rechaza SKU duplicados** con 422 y
    `{"message":"No fue posible guardar tu producto","errors":"Sku Ya está en uso"}`.
    Es una red de seguridad contra altas repetidas, y el sincronizador la
    aprovecha: ante ese error resuelve el `web_id` por SKU y pasa a actualizar.
15. **El `DELETE` no es idempotente y borra de verdad.** El segundo intento da
    404 y el producto ya no responde por `GET`. Por eso las bajas automaticas
    usan `active: false`.
16. **La respuesta del `POST` trae campos que no estan documentados**:
    `discounted_price`, `brand_id` y `brand`.
17. **El `PUT` parcial resuelve el caso principal.** Refrescar precio y stock de
    un producto sin variantes es un payload minimo:
    `{"product":{"price":29.99,"quantity":12}}`. No hay que releer ni reenviar
    el producto entero, con lo cual no se pisan campos que administre otro.
18. **Las variantes son solo-agregar, y eso es un peligro.** El proveedor dice
    que las variantes enviadas *"se agregan a las existentes sin eliminar las
    anteriores"*. De ahi se desprenden dos huecos sin documentar:
    - **No hay forma de borrar** una variante, opcion o combinacion. Un array
      vacio explicitamente **no** borra.
    - **No se sabe que pasa al reenviar una variante con un `sku` que ya
      existe**: ¿la actualiza o la duplica? Si duplica, un sincronizador que
      reenvie variantes en cada ciclo ensucia el catalogo del proveedor de
      forma acumulativa e irreversible.

    Hasta confirmarlo, el sincronizador **no debe reenviar `options` ni
    `variants` salvo cuando detecte una combinacion genuinamente nueva.**
19. **`image_urls` en el `PUT` es ambiguo:** no esta documentado si reemplaza la
    galeria o si agrega a la existente. Mismo riesgo de acumulacion que las
    variantes.
20. **El `sku` es modificable via `PUT`**, asi que no es un identificador
    inmutable del lado del proveedor. El unico identificador estable es el
    `web_id`.
21. **`active: false` es una alternativa mas segura que `DELETE`.** `active` es
    un campo comun editable por `PUT`, asi que dar de baja con
    `{"product":{"active":false}}` es **reversible** y conserva el `web_id`,
    las variantes, las imagenes y el historial. El `DELETE` probablemente no se
    pueda deshacer: si el producto reaparece en la BD habria que recrearlo
    desde cero, con `web_id` nuevo y volviendo a subir las imagenes.

---

## Pendiente de confirmar

- [x] ~~Endpoint de subcategorias~~ — **no existe**. Solo `GET /products` y `GET /products/:id_or_sku`
- [ ] **¿`subcategory_id` es obligatorio en el `POST`?** Si no lo fuera, se destraba la creacion
- [ ] Conseguir el/los `web_id` de subcategoria cargando un producto a mano en el panel
- [ ] **`GET /:id_or_sku`: ¿el identificador va en la ruta o en el query?** Probar contra el API real
- [ ] **`PUT` con un `sku` de variante ya existente: ¿actualiza o duplica?** (critico)
- [ ] **¿Como se borra o desactiva una variante / combinacion?** Sin endpoint conocido
- [ ] **`image_urls` en el `PUT`: ¿reemplaza la galeria o agrega?**
- [ ] `DELETE`: ¿baja fisica o logica? ¿es idempotente (borrar dos veces)?
- [ ] Tras un `DELETE`, ¿se puede volver a crear un producto con el mismo `sku`?
- [ ] ¿Que devuelve `GET /:id_or_sku` si el producto no existe? ¿404 o cuerpo vacio?
- [ ] Codigos de error y formato del cuerpo de error
- [ ] Limite de llamadas por minuto
- [ ] ¿`sku` y `title` son obligatorios? ¿el `sku` debe ser unico?
- [ ] ¿Que pasa al crear un producto con un `sku` que ya existe?
