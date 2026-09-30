/* =====================================================================
   Ajustes sobre dbo.tbl01_api_mercately_sync_producto.

   La tabla quedo creada con las columnas y tipos correctos, pero sin clave
   primaria, sin UNIQUE, sin defaults y sin indices. Esto lo completa.

   Se puede correr tal cual mientras la tabla este VACIA. Con datos cargados,
   los ALTER COLUMN ... NOT NULL fallan si alguna fila tiene NULL en esa
   columna, y el UNIQUE falla si hay SKU repetidos.

   Alternativa: si la tabla sigue vacia, es mas simple hacer
       DROP TABLE dbo.tbl01_api_mercately_sync_producto;
   y volver a correr 001_tablas_sync.sql, que ya la crea completa.
   ===================================================================== */

/* ---------- 1) NOT NULL donde corresponde ---------- */
ALTER TABLE dbo.tbl01_api_mercately_sync_producto ALTER COLUMN sku            NVARCHAR(100) NOT NULL;
GO
ALTER TABLE dbo.tbl01_api_mercately_sync_producto ALTER COLUMN estado         VARCHAR(20)   NOT NULL;
GO
ALTER TABLE dbo.tbl01_api_mercately_sync_producto ALTER COLUMN intentos       INT           NOT NULL;
GO
ALTER TABLE dbo.tbl01_api_mercately_sync_producto ALTER COLUMN fecha_creacion DATETIME2(3)  NOT NULL;
GO


/* ---------- 2) Valores por defecto ---------- */
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_api_mercately_sync_producto_estado')
    ALTER TABLE dbo.tbl01_api_mercately_sync_producto
        ADD CONSTRAINT DF_api_mercately_sync_producto_estado DEFAULT ('PENDIENTE') FOR estado;
GO
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_api_mercately_sync_producto_intentos')
    ALTER TABLE dbo.tbl01_api_mercately_sync_producto
        ADD CONSTRAINT DF_api_mercately_sync_producto_intentos DEFAULT (0) FOR intentos;
GO
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_api_mercately_sync_producto_fcrea')
    ALTER TABLE dbo.tbl01_api_mercately_sync_producto
        ADD CONSTRAINT DF_api_mercately_sync_producto_fcrea DEFAULT (SYSUTCDATETIME()) FOR fecha_creacion;
GO


/* ---------- 3) Clave primaria ---------- */
IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK_api_mercately_sync_producto')
    ALTER TABLE dbo.tbl01_api_mercately_sync_producto
        ADD CONSTRAINT PK_api_mercately_sync_producto PRIMARY KEY CLUSTERED (id);
GO


/* ---------- 4) UNIQUE en sku — la mas importante ----------
   El sincronizador hace UPDATE y, si no afecto ninguna fila, INSERT. Sin esta
   restriccion, un reintento o dos procesos corriendo a la vez pueden dejar dos
   filas para el mismo SKU, y el estado del producto queda partido entre las dos.
   ------------------------------------------------------------ */
IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'UQ_api_mercately_sync_producto_sku')
    ALTER TABLE dbo.tbl01_api_mercately_sync_producto
        ADD CONSTRAINT UQ_api_mercately_sync_producto_sku UNIQUE (sku);
GO


/* ---------- 5) Indices de consulta ---------- */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_api_mercately_sync_producto_estado')
    CREATE INDEX IX_api_mercately_sync_producto_estado
        ON dbo.tbl01_api_mercately_sync_producto (estado) INCLUDE (sku, id_proveedor);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_api_mercately_sync_producto_idprov')
    CREATE INDEX IX_api_mercately_sync_producto_idprov
        ON dbo.tbl01_api_mercately_sync_producto (id_proveedor);
GO
