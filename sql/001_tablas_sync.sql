/* =====================================================================
   Tablas que ESTA API administra (lectura y escritura).

   NO tocan prd0101 ni ninguna tabla del ERP: la tabla de productos la
   alimenta otra fuente y para nosotros es de solo lectura. La unica clave
   foranea es interna, de sync_evento hacia sync_ejecucion.

   El script es idempotente: cada tabla va dentro de un IF ... IS NULL, asi
   que correrlo dos veces no hace nada la segunda.

   SI CAMBIAS LOS NOMBRES DE TABLA, actualiza tambien el .env:
     DB_ESQUEMA
     DB_TABLA_SYNC_PRODUCTO
     DB_TABLA_SYNC_EJECUCION
     DB_TABLA_SYNC_EVENTO
   ===================================================================== */

/* ---------------------------------------------------------------------
   1) tbl01_api_mercately_sync_producto
   Una fila por producto. Guarda la "huella" de lo ultimo que le enviamos
   a Mercately, para detectar que cambio sin reenviar todo el catalogo en
   cada ciclo.
   --------------------------------------------------------------------- */
IF OBJECT_ID('dbo.tbl01_api_mercately_sync_producto', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tbl01_api_mercately_sync_producto (
        id                      BIGINT          IDENTITY(1,1) NOT NULL,

        -- ---------- Identidad ----------
        -- prd0101.codi, el codigo del producto en el ERP. Unico en los 1.086
        -- que pasan el filtro. Es la clave de emparejamiento con Mercately.
        sku                     NVARCHAR(100)   NOT NULL,
        -- El web_id que devuelve Mercately al crear. Sin el no se puede
        -- actualizar ni dar de baja el producto despues.
        id_proveedor            NVARCHAR(100)   NULL,

        -- ---------- Huella del ultimo envio ----------
        -- SHA-256 del payload enviado: si no cambia, no reenviamos nada.
        hash_payload            CHAR(64)        NULL,
        -- El payload completo del ultimo envio, en JSON. Permite calcular el
        -- delta exacto y mandar solo los campos que de verdad cambiaron, sin
        -- pisar lo que alguien edite a mano en el panel de Mercately.
        payload_enviado         NVARCHAR(MAX)   NULL,
        precio_enviado          DECIMAL(18, 4)  NULL,
        stock_enviado           INT             NULL,
        activo_enviado          BIT             NULL,

        -- ---------- Estado ----------
        -- PENDIENTE | SINCRONIZADO | ERROR | ELIMINADO
        estado                  VARCHAR(20)     NOT NULL
            CONSTRAINT DF_api_mercately_sync_producto_estado DEFAULT ('PENDIENTE'),
        intentos                INT             NOT NULL
            CONSTRAINT DF_api_mercately_sync_producto_intentos DEFAULT (0),
        ultimo_error            NVARCHAR(MAX)   NULL,

        -- ---------- Auditoria ----------
        fecha_creacion          DATETIME2(3)    NOT NULL
            CONSTRAINT DF_api_mercately_sync_producto_fcrea DEFAULT (SYSUTCDATETIME()),
        fecha_ultimo_intento    DATETIME2(3)    NULL,
        fecha_sincronizado      DATETIME2(3)    NULL,
        fecha_eliminado         DATETIME2(3)    NULL,

        CONSTRAINT PK_api_mercately_sync_producto PRIMARY KEY CLUSTERED (id),
        CONSTRAINT UQ_api_mercately_sync_producto_sku UNIQUE (sku)
    );

    CREATE INDEX IX_api_mercately_sync_producto_estado
        ON dbo.tbl01_api_mercately_sync_producto (estado) INCLUDE (sku, id_proveedor);
    CREATE INDEX IX_api_mercately_sync_producto_idprov
        ON dbo.tbl01_api_mercately_sync_producto (id_proveedor);
END
GO


/* ---------------------------------------------------------------------
   2) tbl01_api_mercately_sync_ejecucion
   Una fila por corrida del sincronizador (cron o manual). Sirve para el
   tablero de "como vamos" y para saber si el cron dejo de correr.
   --------------------------------------------------------------------- */
IF OBJECT_ID('dbo.tbl01_api_mercately_sync_ejecucion', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tbl01_api_mercately_sync_ejecucion (
        id              BIGINT          IDENTITY(1,1) NOT NULL,
        -- CRON | MANUAL
        origen          VARCHAR(20)     NOT NULL,
        -- EN_CURSO | OK | ERROR
        estado          VARCHAR(20)     NOT NULL
            CONSTRAINT DF_api_mercately_sync_ejecucion_estado DEFAULT ('EN_CURSO'),

        fecha_inicio    DATETIME2(3)    NOT NULL
            CONSTRAINT DF_api_mercately_sync_ejecucion_ini DEFAULT (SYSUTCDATETIME()),
        fecha_fin       DATETIME2(3)    NULL,
        duracion_ms     INT             NULL,

        -- Contadores del ciclo
        leidos          INT             NOT NULL CONSTRAINT DF_api_merc_sync_ejec_leidos DEFAULT (0),
        creados         INT             NOT NULL CONSTRAINT DF_api_merc_sync_ejec_creados DEFAULT (0),
        actualizados    INT             NOT NULL CONSTRAINT DF_api_merc_sync_ejec_actualizados DEFAULT (0),
        eliminados      INT             NOT NULL CONSTRAINT DF_api_merc_sync_ejec_eliminados DEFAULT (0),
        sin_cambios     INT             NOT NULL CONSTRAINT DF_api_merc_sync_ejec_sincambios DEFAULT (0),
        errores         INT             NOT NULL CONSTRAINT DF_api_merc_sync_ejec_errores DEFAULT (0),

        mensaje_error   NVARCHAR(MAX)   NULL,

        CONSTRAINT PK_api_mercately_sync_ejecucion PRIMARY KEY CLUSTERED (id)
    );

    CREATE INDEX IX_api_mercately_sync_ejecucion_fecha
        ON dbo.tbl01_api_mercately_sync_ejecucion (fecha_inicio DESC);
END
GO


/* ---------------------------------------------------------------------
   3) tbl01_api_mercately_sync_evento
   Bitacora fina: una fila por operacion contra el API de Mercately.
   Es lo que permite responder "que paso exactamente con el SKU X".
   --------------------------------------------------------------------- */
IF OBJECT_ID('dbo.tbl01_api_mercately_sync_evento', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tbl01_api_mercately_sync_evento (
        id                  BIGINT          IDENTITY(1,1) NOT NULL,
        id_ejecucion        BIGINT          NULL,

        sku                 NVARCHAR(100)   NOT NULL,
        id_proveedor        NVARCHAR(100)   NULL,
        -- CREAR | ACTUALIZAR | BAJA | ELIMINAR
        operacion           VARCHAR(20)     NOT NULL,
        -- OK | ERROR
        resultado           VARCHAR(20)     NOT NULL,

        http_status         INT             NULL,
        -- Recortados a 8000 caracteres desde la aplicacion.
        request_payload     NVARCHAR(MAX)   NULL,
        response_payload    NVARCHAR(MAX)   NULL,
        mensaje_error       NVARCHAR(MAX)   NULL,
        duracion_ms         INT             NULL,

        fecha               DATETIME2(3)    NOT NULL
            CONSTRAINT DF_api_mercately_sync_evento_fecha DEFAULT (SYSUTCDATETIME()),

        CONSTRAINT PK_api_mercately_sync_evento PRIMARY KEY CLUSTERED (id),
        CONSTRAINT FK_api_mercately_sync_evento_ejecucion FOREIGN KEY (id_ejecucion)
            REFERENCES dbo.tbl01_api_mercately_sync_ejecucion (id)
    );

    CREATE INDEX IX_api_mercately_sync_evento_sku_fecha
        ON dbo.tbl01_api_mercately_sync_evento (sku, fecha DESC);
    CREATE INDEX IX_api_mercately_sync_evento_ejecucion
        ON dbo.tbl01_api_mercately_sync_evento (id_ejecucion);
END
GO
