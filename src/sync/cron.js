import cron from 'node-cron';

import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { sincronizar, estaCorriendo } from './sincronizador.js';

const log = logger.child({ modulo: 'cron' });

let tarea = null;
let ultimoResultado = null;
let ultimoError = null;

export function iniciarCron() {
  if (!env.SYNC_ENABLED) {
    log.warn('SYNC_ENABLED=false: el cron no se programa. La sincronizacion queda solo manual.');
    return null;
  }

  if (!cron.validate(env.SYNC_CRON)) {
    throw new Error(`SYNC_CRON invalido: "${env.SYNC_CRON}"`);
  }

  tarea = cron.schedule(env.SYNC_CRON, async () => {
    // Si la corrida anterior sigue viva, este ciclo se saltea. Es preferible
    // perder un ciclo a solapar dos sincronizaciones sobre el mismo catalogo.
    if (estaCorriendo()) {
      log.warn('Ciclo salteado: la sincronizacion anterior sigue en curso');
      return;
    }

    try {
      ultimoResultado = await sincronizar({ origen: 'CRON' });
      ultimoError = null;
    } catch (err) {
      ultimoError = { mensaje: err.message, fecha: new Date().toISOString() };
      log.error({ err }, 'Fallo la sincronizacion programada');
    }
  });

  log.info({ expresion: env.SYNC_CRON }, 'Cron de sincronizacion programado');
  return tarea;
}

export function detenerCron() {
  tarea?.stop();
  tarea = null;
}

export function estadoCron() {
  return {
    programado: Boolean(tarea),
    habilitado: env.SYNC_ENABLED,
    expresion: env.SYNC_CRON,
    corriendo: estaCorriendo(),
    ultimoResultado,
    ultimoError,
  };
}
