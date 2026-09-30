/*
 * Limpieza de las descripciones que vienen de `prd0101.obse`.
 *
 * Ese campo mezcla tres formatos: texto plano con saltos de linea, HTML suelto
 * (<p>, &amp;, &nbsp;, a veces <table>), y vacio. Mercately devuelve sus
 * descripciones en texto plano, asi que mandar HTML crudo se veria roto si su
 * tienda no lo renderiza. Texto limpio se ve bien en los dos casos.
 */

const ENTIDADES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Uuml: 'Ü',
  ntilde: 'ñ', Ntilde: 'Ñ', ordm: 'º', ordf: 'ª', deg: '°',
  trade: '™', reg: '®', copy: '©', hellip: '…', mdash: '—', ndash: '–',
  laquo: '«', raquo: '»', ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'",
  euro: '€', pound: '£', yen: '¥', cent: '¢', middot: '·', bull: '•',
  // Simbolos que aparecen en las fichas tecnicas (rangos, tolerancias, medidas).
  times: '×', divide: '÷', minus: '−', plusmn: '±', asymp: '≈', ne: '≠',
  le: '≤', ge: '≥', infin: '∞', micro: 'µ', sup1: '¹', sup2: '²', sup3: '³',
  frac12: '½', frac14: '¼', frac34: '¾', rarr: '→', larr: '←', harr: '↔',
  sect: '§', para: '¶', dagger: '†', iexcl: '¡', iquest: '¿', ccedil: 'ç',
};

function decodificarEntidades(texto) {
  return texto
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (original, nombre) => ENTIDADES[nombre] ?? original);
}

/**
 * Convierte HTML o texto crudo en texto plano legible.
 * Devuelve null si no queda nada util, para que el llamador use su alternativa.
 */
export function limpiarHtml(valor) {
  if (valor === null || valor === undefined) return null;

  let texto = String(valor);

  // El HTML de origen viene indentado con saltos entre tags. Si no se quitan
  // antes, cada </p><p> deja una linea en blanco de mas en el resultado.
  texto = texto.replace(/>\s+</g, '><');
  // Los cierres de bloque marcan fin de linea antes de borrar el resto de tags.
  texto = texto.replace(/<\s*(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/blockquote)\s*\/?>/gi, '\n');
  // Las celdas de tabla se separan para que no se peguen las palabras.
  texto = texto.replace(/<\s*\/\s*(td|th)\s*>/gi, '\t');
  texto = texto.replace(/<[^>]*>/g, ' ');

  texto = decodificarEntidades(texto);

  // En los volcados de especificaciones el tabulador separa etiqueta de valor
  // ("Color\tNegro"), asi que leerlo como "Color: Negro" conserva el sentido.
  texto = texto.replace(/\r\n?/g, '\n').replace(/\t+/g, ': ');
  texto = texto.replace(/[  ]+/g, ' ');

  const lineas = texto
    .split('\n')
    .map((linea) => linea.trim().replace(/:\s*$/, ''))
    .filter((linea, i, todas) => linea !== '' || (i > 0 && todas[i - 1].trim() !== ''));

  const limpio = lineas.join('\n').trim();
  return limpio === '' ? null : limpio;
}
