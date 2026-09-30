/* =====================================================================
   Ajustes sobre tbl01_api_mercately_sync_ejecucion y _evento.

   Ambas quedaron con las columnas y la nulabilidad correctas, y con una
   clave primaria de nombre autogenerado, pero sin valores por defecto, sin
   la clave foranea entre ellas y sin indices de consulta.

   El codigo ya no depende de estos DEFAULT (pasa todos los valores
   explicitamente), asi que esto es calidad de datos y rendimiento, no un
   arreglo urgente.

   Seguro de repetir: todo va bajo IF NOT EXISTS.
   ===================================================================== */

/* ---------- tbl01_api_mercately_sync_ejecucion ---------- */

IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_api_mercately_sync_ejecucion_estado')
    ALTER TABLE dbo.tbl01_api_mercately_sync_ejecucion
        ADD CONSTRAINT DF_api_mercately_sync_ejecucion_estado DEFAULT ('EN_CURSO') FOR estado;
GO
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_api_mercately_sync_ejecucion_ini')
    ALTER TABLE dbo.tbl01_api_mercately_sync_ejecucion
        ADD CONSTRAINT DF_api_mercately_sync_ejecucion_ini DEFAULT (SYSUTCDATETIME()) FOR fecha_inicio;
GO
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_api_merc_sync_ejec_leidos')
    ALTER TABLE dbo.tbl01_api_mercately_sync_ejecucion
        ADD CONSTRAINT DF_api_merc_sync_ejec_leidos DEFAULT (0) FOR leidos;
GO
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_api_merc_sync_ejec_creados')
    ALTER TABLE dbo.tbl01_api_mercately_sync_ejecucion
        ADD CONSTRAINT DF_api_merc_sync_ejec_creados DEFAULT (0) FOR creados;
GO
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_api_merc_sync_ejec_actualizados')
    ALTER TABLE dbo.tbl01_api_mercately_sync_ejecucion
        ADD CONSTRAINT DF_api_merc_sync_ejec_actualizados DEFAULT (0) FOR actualizados;
GO
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_api_merc_sync_ejec_eliminados')
    ALTER TABLE dbo.tbl01_api_mercately_sync_ejecucion
        ADD CONSTRAINT DF_api_merc_sync_ejec_eliminados DEFAULT (0) FOR eliminados;
GO
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_api_merc_sync_ejec_sincambios')
    ALTER TABLE dbo.tbl01_api_mercately_sync_ejecucion
        ADD CONSTRAINT DF_api_merc_sync_ejec_sincambios DEFAULT (0) FOR sin_cambios;
GO
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_api_merc_sync_ejec_errores')
    ALTER TABLE dbo.tbl01_api_mercately_sync_ejecucion
        ADD CONSTRAINT DF_api_merc_sync_ejec_errores DEFAULT (0) FOR errores;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_api_mercately_sync_ejecucion_fecha')
    CREATE INDEX IX_api_mercately_sync_ejecucion_fecha
        ON dbo.tbl01_api_mercately_sync_ejecucion (fecha_inicio DESC);
GO


/* ---------- tbl01_api_mercately_sync_evento ---------- */

IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_api_mercately_sync_evento_fecha')
    ALTER TABLE dbo.tbl01_api_mercately_sync_evento
        ADD CONSTRAINT DF_api_mercately_sync_evento_fecha DEFAULT (SYSUTCDATETIME()) FOR fecha;
GO

/* La FK evita eventos huerfanos apuntando a una corrida que no existe.
   id_ejecucion admite NULL: los eventos disparados desde los endpoints
   manuales no pertenecen a ninguna corrida. */
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_api_mercately_sync_evento_ejecucion')
    ALTER TABLE dbo.tbl01_api_mercately_sync_evento
        ADD CONSTRAINT FK_api_mercately_sync_evento_ejecucion FOREIGN KEY (id_ejecucion)
            REFERENCES dbo.tbl01_api_mercately_sync_ejecucion (id);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_api_mercately_sync_evento_sku_fecha')
    CREATE INDEX IX_api_mercately_sync_evento_sku_fecha
        ON dbo.tbl01_api_mercately_sync_evento (sku, fecha DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_api_mercately_sync_evento_ejecucion')
    CREATE INDEX IX_api_mercately_sync_evento_ejecucion
        ON dbo.tbl01_api_mercately_sync_evento (id_ejecucion);
GO
