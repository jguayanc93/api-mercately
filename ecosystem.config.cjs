/*
 * Configuracion de PM2.
 *
 * Va en .cjs y no en .js porque package.json declara "type": "module" y PM2
 * lee este archivo como CommonJS.
 */
module.exports = {
  apps: [
    {
      /*
       * Este nombre tiene que ser unico entre todas las apps del servidor:
       * `pm2 start` con un nombre repetido pisa la app existente. Verificar con
       * `pm2 list` antes del primer despliegue.
       */
      name: 'api-mercateli',
      script: 'src/server.js',

      /*
       * UNA sola instancia, en modo fork.
       *
       * Con cluster_mode y N instancias, cada worker programaria su propio cron
       * y el catalogo se sincronizaria N veces en paralelo, pisandose entre si.
       * Si algun dia hace falta escalar horizontalmente, primero hay que sacar
       * el cron del proceso web.
       */
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      max_memory_restart: '400M',

      /*
       * El apagado ordenado de src/server.js para el cron, cierra el server HTTP
       * y despues el pool de SQL Server, con un tope propio de 10 segundos.
       *
       * PM2 manda SIGKILL a los 1600 ms por defecto, o sea que cortaria ese
       * apagado por la mitad: una sincronizacion en curso quedaria a medias y el
       * pool sin cerrar. 15 segundos le dan margen al apagado limpio.
       */
      kill_timeout: 15_000,

      env: {
        NODE_ENV: 'production',
      },

      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
