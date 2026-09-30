import { createHash } from 'node:crypto';

/**
 * Lleva un precio a su forma canonica en texto: "39.99".
 *
 * Mercately recibe numeros (`price: 12`) y devuelve strings (`"price": "1.5"`).
 * Sin normalizar, "20.0", "20.00" y 20 se ven como tres valores distintos y el
 * sincronizador dispararia un PUT por producto en cada ciclo sin que nada haya
 * cambiado realmente.
 */
export function normalizarPrecio(valor, escala = 2) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = typeof valor === 'number' ? valor : Number(String(valor).trim().replace(',', '.'));
  return Number.isFinite(n) ? n.toFixed(escala) : null;
}

/** Igual que normalizarPrecio pero devuelve numero, que es lo que espera el POST/PUT. */
export function precioANumero(valor, escala = 2) {
  const texto = normalizarPrecio(valor, escala);
  return texto === null ? null : Number(texto);
}

export function normalizarEntero(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function normalizarTexto(valor) {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).trim();
  return texto === '' ? null : texto;
}

export function normalizarBooleano(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (typeof valor === 'boolean') return valor;
  if (typeof valor === 'number') return valor !== 0;
  return ['true', '1', 'si', 'sí', 'y', 's'].includes(String(valor).trim().toLowerCase());
}

/** Reescribe el objeto con las claves ordenadas, para que el hash no dependa del orden. */
function estable(valor) {
  if (Array.isArray(valor)) return valor.map(estable);
  if (valor && typeof valor === 'object') {
    return Object.keys(valor)
      .sort()
      .reduce((acc, clave) => {
        acc[clave] = estable(valor[clave]);
        return acc;
      }, {});
  }
  return valor;
}

/** SHA-256 del objeto normalizado. Es la huella que guardamos en sync_producto. */
export function hashEstable(objeto) {
  return createHash('sha256').update(JSON.stringify(estable(objeto))).digest('hex');
}

/**
 * Campos presentes en `nuevo` cuyo valor difiere de `anterior`.
 *
 * Compara en profundidad, porque `image_urls` es un array y con `===` dos
 * arrays de igual contenido siempre darian distintos.
 */
export function camposQueCambiaron(nuevo, anterior) {
  const cambios = {};
  for (const [clave, valor] of Object.entries(nuevo)) {
    const previo = anterior?.[clave];
    const iguales =
      valor !== null && typeof valor === 'object'
        ? JSON.stringify(estable(valor)) === JSON.stringify(estable(previo))
        : Object.is(valor, previo ?? null);
    if (!iguales) cambios[clave] = valor;
  }
  return cambios;
}
