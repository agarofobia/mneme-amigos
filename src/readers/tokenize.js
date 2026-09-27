// The one tokenizer of every reader. The index and the query MUST go through this same
// function: if they tokenize differently, terms never match and search returns nothing,
// without any error. Changing it (or STOPWORDS) requires bumping INDEX_VERSION in
// ./index.js so existing indexes are rebuilt.

/**
 * Function words that never help choose a section. English and Spanish, written without
 * accents because tokens are compared after accents are stripped.
 */
export const STOPWORDS = new Set([
  // English
  'about', 'above', 'after', 'again', 'against', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'could',
  'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has',
  'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'if', 'in',
  'into', 'is', 'it', 'its', 'itself', 'just', 'may', 'me', 'might', 'more', 'most', 'must', 'my', 'myself',
  'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves',
  'out', 'over', 'own', 'same', 'shall', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the',
  'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through',
  'to', 'too', 'under', 'until', 'up', 'us', 'very', 'via', 'was', 'we', 'were', 'what', 'when', 'where',
  'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'without', 'would', 'yet', 'you', 'your',
  'yours', 'yourself', 'yourselves',
  // Spanish (accents stripped)
  'al', 'algo', 'algunas', 'algunos', 'ante', 'antes', 'aqui', 'alli', 'ahi', 'asi', 'aquel', 'aquella',
  'cada', 'como', 'con', 'contra', 'cual', 'cuales', 'cuando', 'de', 'del', 'desde', 'despues', 'donde',
  'durante', 'el', 'ella', 'ellas', 'ellos', 'en', 'entonces', 'entre', 'era', 'eran', 'es', 'esa', 'esas',
  'ese', 'eso', 'esos', 'esta', 'estan', 'estar', 'estas', 'este', 'esto', 'estos', 'fue', 'fueron', 'ha',
  'habia', 'han', 'hasta', 'hay', 'hemos', 'hacia', 'la', 'las', 'le', 'les', 'lo', 'los', 'luego', 'mas',
  'me', 'mi', 'mia', 'mio', 'mis', 'mucho', 'muchos', 'muy', 'nada', 'ni', 'nos', 'nosotras', 'nosotros',
  'nuestra', 'nuestro', 'os', 'otra', 'otras', 'otro', 'otros', 'para', 'pero', 'poco', 'por', 'porque',
  'que', 'quien', 'quienes', 'se', 'segun', 'ser', 'sera', 'si', 'sin', 'sobre', 'solo', 'son', 'su', 'sus',
  'suya', 'suyo', 'tambien', 'tampoco', 'tanto', 'te', 'ti', 'todo', 'todos', 'tras', 'tu', 'tus', 'tuya',
  'tuyo', 'un', 'una', 'uno', 'unos', 'vosotros', 'ya', 'yo',
]);

/**
 * Lower case, accents removed (NFD without combining marks), split on anything that is
 * not a letter or a digit, stopwords dropped, tokens of at least 2 characters.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  /** @type {string[]} */
  const out = [];
  const plain = String(text).toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '');
  for (const token of plain.split(/[^\p{L}\p{N}]+/u)) {
    if (token.length >= 2 && !STOPWORDS.has(token)) out.push(token);
  }
  return out;
}

/**
 * Term frequencies of `text`. A Map, never a plain object: a plain object inherits
 * `constructor`, `toString`… and a note that contains those words would corrupt the count.
 * @param {string} text
 * @returns {Map<string, number>}
 */
export function termFrequencies(text) {
  /** @type {Map<string, number>} */
  const tf = new Map();
  for (const token of tokenize(text)) tf.set(token, (tf.get(token) ?? 0) + 1);
  return tf;
}
