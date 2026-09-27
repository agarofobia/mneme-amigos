// Los usos (mapa ①.d): la configuración recomendada según para qué se usa una raíz, armada con el
// catálogo de la charla que dio origen a Mneme (24/09 20:35: «RAG, CAG, KAG, cualquier sistema de
// control de contexto» y «métodos de vectorización… si hay más, estaría genial»).
// Andamio del boceto: en la app es src/usos.js. Sin imports de Node, así lo importan export.mjs,
// medir-analisis.mjs y la página, y hay una sola copia.

/** Dónde está cada forma respecto de Mneme. */
export const ESTADOS = {
  trae: 'Mneme lo trae',
  enchufe: 'se enchufa',
  despues: 'después de v1',
  eval: 'si el eval lo pide',
  agente: 'lo hace el agente',
  propuesto: 'propuesto, sin medir',
  descartado: 'descartado',
};

// Decidir antes de buscar (Spec - Mneme §Decidir antes de buscar, 25/09): modelos System One que
// contestan preguntas tipadas con probabilidades, adentro del hook, antes de que la IA vea el prompt.
export const DECISORES = [
  { id: 'kev', nombre: 'Kev-0.8B', que: 'System One abierto (Qwen3.5 + LoRA, Apache 2.0) con la misma API que Jev; ≈ 4 GB de VRAM', estado: 'descartado', donde: 'medido el 25/09 como compuerta, tal cual viene, sobre 84 mensajes: no separa lo del vault de lo ajeno (AUC 0,68 en español, 0,45 en inglés); con el umbral que deja afuera lo ajeno no pasa ningún acierto. Latencia ~100 ms. Sin entrenarlo con datos del vault no sirve' },
  { id: 'laya', nombre: 'Laya-multilingual', que: 'System One abierto (mmBERT, 322 M, Apache 2.0), CPU o GPU en ~33 ms', estado: 'despues', donde: 'se declara no zero-shot: sólo tiene sentido entrenado con etiquetas propias del vault, como Kev' },
  { id: 'qwen3-reranker', nombre: 'Qwen3-Reranker-0.6B', que: 'decide si una sección responde a un mensaje, mirando las dos (lo que la compuerta no puede sin conocer las notas)', estado: 'propuesto', donde: 'ya está instalado en Ollama; es la forma de la pregunta que sí tiene con qué decidir: después de buscar, no antes' },
  { id: 'jev', nombre: 'Jev', que: 'el primer System One (TypeSafe), cerrado, por API', estado: 'propuesto', donde: 'la misma API que Kev: sería una URL en la config, para quien acepte la nube' },
  { id: 'gliner', nombre: 'GLiNER2.5-Decide', que: 'System One abierto (DeBERTa-v3, Apache 2.0)', estado: 'descartado', donde: 'no declara español, y DeBERTa-v3 es inglés' },
];

// Las formas de leer el contexto (Spec - Mneme §Lectores). `donde`: cómo se usa hoy, o por qué no.
export const LECTORES = [
  { id: 'rag', nombre: 'RAG', que: 'parte en pedazos, busca los parecidos a la pregunta y los pega', estado: 'trae', donde: 'el lector híbrido (BM25 + embeddings, RRF) o el léxico; el pedazo es la sección' },
  { id: 'contextual', nombre: 'Contextual Retrieval', que: 'a cada pedazo le antepone de qué documento viene', estado: 'trae', donde: 'gratis con markdown: el encabezado padre ya lo dice' },
  { id: 'agentica', nombre: 'búsqueda agéntica', que: 'el agente decide qué buscar y con qué herramienta', estado: 'trae', donde: 'el MCP expone buscar, leer e historial' },
  { id: 'cag', nombre: 'CAG', que: 'todo el conocimiento chico y estable, precargado y cacheado', estado: 'trae', donde: 'mneme bundle y el wake-up al abrir sesión (wakeUpBudget)' },
  { id: 'capas', nombre: 'carga por capas', que: 've la descripción y carga el cuerpo a pedido (como las Skills)', estado: 'trae', donde: 'el paquete CAG es un índice con punteros: las fijas enteras, el resto una línea' },
  { id: 'temporal', nombre: 'memoria temporal', que: 'cada hecho dice desde cuándo y hasta cuándo vale (Zep, Graphiti)', estado: 'trae', donde: 'expires y superseded_by en el frontmatter; lo vencido sale marcado' },
  { id: 'propio', nombre: 'un lector propio', que: 'el método que se te ocurra, sobre el mismo almacén', estado: 'enchufe', donde: 'por librería hoy; search.reader: "module" está propuesto para que lo usen hooks y MCP' },
  { id: 'grafo', nombre: 'grafo de wikilinks', que: 'recorre los enlaces desde lo encontrado (un salto + PageRank, la versión pobre de HippoRAG)', estado: 'despues', donde: 'el grafo ya existe y lo escribió una persona: los wikilinks' },
  { id: 'raptor', nombre: 'RAPTOR', que: 'un árbol de resúmenes, para buscar con distinto nivel de detalle', estado: 'despues', donde: 'un núcleo compilado por proyecto es su versión de un nivel' },
  { id: 'graphrag', nombre: 'GraphRAG · LightRAG', que: 'un grafo de entidades con resúmenes por grupo, para preguntas sobre el conjunto', estado: 'eval', donde: 'un grafo extraído por una IA es una copia de las notas que envejece' },
  { id: 'kag', nombre: 'KAG', que: 'grafo con esquema y razonamiento lógico, para preguntas de varios saltos', estado: 'eval', donde: 'el 24/09 arreglaba 1 o 2 de las 6 fallas medidas: lo decide el tipo de falla, no el tamaño' },
  { id: 'reescritura', nombre: 'reescribir la consulta', que: 'un modelo local agrega palabras a la pregunta (expansión) o escribe la nota que la respondería (HyDE), y se busca con eso', estado: 'descartado', donde: 'medido el 25/09 con gemma4:12b local: baja los aciertos y deja pasar lo ajeno (expansión: ajenos 2/5 y 9/14; HyDE: 0/5 y 0/14), a 1-2,3 s por consulta. Reescribir la búsqueda lo hace mejor el agente, que sabe qué quiere' },
  { id: 'selfrag', nombre: 'Self-RAG · CRAG', que: 'juzga si lo que trajo sirve y vuelve a buscar', estado: 'agente', donde: 'es un paso del razonamiento, no del almacén' },
  { id: 'especulativo', nombre: 'Speculative RAG', que: 'un borrador rápido; si alcanza, se saltea la búsqueda', estado: 'agente', donde: 'ídem' },
  { id: 'compactar', nombre: 'compactación', que: 'resume o saca lo viejo cuando el contexto se llena', estado: 'agente', donde: 'es del agente' },
  { id: 'tag', nombre: 'TAG', que: 'una consulta SQL a datos estructurados', estado: 'descartado', donde: 'no es conocimiento en prosa' },
];

// Los métodos de vectorización (Spec - Mneme §Vectorización).
export const VECTORES = [
  { id: 'bm25', nombre: 'BM25', que: 'TF-IDF con dos arreglos: una palabra repetida 10 veces no vale 10 veces más, y lo largo no gana por largo', estado: 'trae', donde: 'ranking.k1 y ranking.b' },
  { id: 'rrf', nombre: 'híbrido por RRF', que: 'une el ranking léxico y el semántico por posición, sin calibrar escalas', estado: 'trae', donde: 'ranking.rrfK' },
  { id: 'ingles', nombre: 'embedding en inglés', que: 'nomic-embed-text v1.5 (768 dimensiones), con sus prefijos de consulta y documento', estado: 'trae', donde: 'embeddings.provider: "ollama"' },
  { id: 'multilingue', nombre: 'embedding multilingüe', que: 'bge-m3 · multilingual-e5 · nomic v2-moe · Qwen3-Embedding · EmbeddingGemma: entienden otros idiomas que el inglés', estado: 'trae', donde: 'el mismo proveedor, otro embeddings.model. Medido el 25/09 sobre un vault en español: bge-m3 no le ganó a nomic con sus prefijos (20/24 contra 21/24): es un dato, no una regla' },
  { id: 'api', nombre: 'embedding por API o propio', que: 'OpenAI · Voyage · Cohere, o el modelo que armes', estado: 'enchufe', donde: 'embeddings.provider: "module" (createEmbedder)' },
  { id: 'splade', nombre: 'SPLADE', que: 'léxico aprendido: le agrega a cada pasaje las palabras relacionadas que no tiene', estado: 'despues', donde: 'experimento' },
  { id: 'colbert', nombre: 'ColBERT', que: 'un vector por palabra: más preciso en frases largas, más pesado', estado: 'despues', donde: 'experimento' },
  { id: 'reranker', nombre: 'reranker', que: 'relee pregunta y pasaje juntos y reordena los primeros', estado: 'despues', donde: 'experimento sin expectativa: a klypix le bajó la precisión' },
  { id: 'compresion', nombre: 'Matryoshka · cuantización', que: 'achican los vectores sin reentrenar', estado: 'despues', donde: 'si el caché molesta (hoy pesa 28 MB)' },
  { id: 'palabras', nombre: 'word2vec · GloVe · fastText', que: 'un vector por palabra, sin contexto', estado: 'descartado', donde: 'los de pasajes los superan' },
];

/** El tope del paquete de «memoria chica»: más que esto ya no es chica. */
const TOPE_CAG = 262144;
const MULTILINGUE = /bge-m3|e5|multilingual|gemma|qwen3|v2-moe|paraphrase|labse/i;
const INGLES = /nomic-embed-text(?!-v2)|mxbai|all-minilm|snowflake|bge-(small|base|large)-en/i;
const PREFIJOS_NOMIC = { queryPrefix: 'search_query: ', documentPrefix: 'search_document: ' };

/**
 * Cada uso: qué es, cuándo sirve, con qué lee, y el parche que aplica sobre la config vigente.
 * El parche cambia **cómo se lee**, no lo que la raíz ya calibró (lo ignorado, los pisos léxicos).
 * `firma(config, señales)`: si una config ya es de este uso (para decir «la vigente se le parece»).
 * @type {Array<{ id: string, nombre: string, sirve: string, lee: string, lectores: string[], vectores: string[],
 *   parche: (s: any, vigente: any, defaults: any) => object, firma: (c: any, s: any) => boolean, nota?: string }>}
 */
export const USOS = [
  {
    id: 'chica', nombre: 'memoria chica',
    sirve: 'todo cabe en el contexto y cambia poco',
    lee: 'CAG: el paquete entero al abrir cada sesión, y léxico para lo puntual',
    lectores: ['cag', 'capas', 'rag'], vectores: ['bm25'],
    parche: (s) => ({ embeddings: { provider: 'none' }, wakeUpBudget: Math.min(TOPE_CAG, Math.max(1024, Math.ceil(s.bytes * 1.1))) }),
    firma: (c, s) => c.embeddings.provider === 'none' && c.wakeUpBudget >= s.bytes,
  },
  {
    id: 'cerebro', nombre: 'memoria personal',
    sirve: 'notas propias en prosa, más de lo que entra, en otro idioma que el inglés, que cambian seguido',
    lee: 'RAG híbrido: BM25 y un embedding multilingüe (bge-m3), unidos por RRF, y un paquete chico al abrir sesión',
    lectores: ['rag', 'contextual', 'agentica', 'cag', 'capas', 'temporal'], vectores: ['bm25', 'multilingue', 'rrf'],
    parche: (_s, v) => ({
      embeddings: { provider: 'ollama', model: 'bge-m3', queryPrefix: '', documentPrefix: '' },
      // el piso de coseno es del modelo: con otro embedding no vale el calibrado
      ...(v.embeddings.model === 'bge-m3' ? {} : { search: { minCosine: 1 } }),
      wakeUpBudget: 16384,
    }),
    firma: (c) => c.embeddings.provider === 'ollama' && MULTILINGUE.test(c.embeddings.model),
    nota: 'el piso de coseno es del modelo: con otro embedding se apaga hasta recalibrarlo con el eval, y mientras tanto pasa lo que pasa por BM25',
  },
  {
    id: 'tecnica', nombre: 'documentación técnica',
    sirve: 'docs de un repo: identificadores exactos, en inglés, con bloques de código',
    lee: 'híbrido con un embedding en inglés (nomic-embed-text con sus prefijos), y BM25 para la palabra exacta',
    lectores: ['rag', 'contextual', 'agentica'], vectores: ['bm25', 'ingles', 'rrf'],
    parche: (_s, v, d) => ({
      embeddings: { provider: 'ollama', model: 'nomic-embed-text', ...PREFIJOS_NOMIC },
      ...(v.embeddings.model === 'nomic-embed-text' ? {} : { search: { minCosine: 1 } }),
      ignoreDirs: [...new Set([...v.ignoreDirs, ...d.ignoreDirs, 'dist', 'build', 'vendor'])],
    }),
    firma: (c) => c.embeddings.provider === 'ollama' && INGLES.test(c.embeddings.model),
  },
  {
    id: 'liviano', nombre: 'liviano',
    sirve: 'sin GPU ni Ollama, o sin dependencias',
    lee: 'sólo léxico: BM25',
    lectores: ['rag', 'agentica'], vectores: ['bm25'],
    parche: () => ({ embeddings: { provider: 'none' } }),
    firma: (c, s) => c.embeddings.provider === 'none' && c.wakeUpBudget < s.bytes,
  },
  {
    id: 'propio', nombre: 'a tu manera',
    sirve: 'quieres probar otro método: otro embedding, otros números',
    lee: 'con lo tuyo: un embedding propio (OpenAI, Voyage, Cohere, el que armes) y el ranking a mano',
    lectores: ['rag', 'propio'], vectores: ['bm25', 'api', 'rrf'],
    parche: () => ({ embeddings: { provider: 'module', module: '' }, search: { minCosine: 1 } }),
    firma: (c) => c.embeddings.provider === 'module',
    nota: 'falta el archivo del módulo, a propósito: lo elige quien lo usa',
  },
];

/**
 * Cuál uso es el ◆ para lo que la raíz tiene. Es la regla que decide: una frase por rama.
 * @param {{ bytes: number, idioma: { es: number, en: number }, codigo: number, cambio14: number }} s
 * @returns {{ id: string, porque: string }}
 */
export function recomendar(s) {
  const kb = Math.round(s.bytes / 1024);
  if (s.bytes * 1.1 <= TOPE_CAG && s.cambio14 < 0.3) return { id: 'chica', porque: `${kb} KB entran enteros en el contexto y cambió el ${pct(s.cambio14)} en 14 días` };
  if (s.idioma.en >= 0.6 && s.codigo >= 0.3) return { id: 'tecnica', porque: `en inglés (${pct(s.idioma.en)}) y con código en el ${pct(s.codigo)} de las notas` };
  if (s.idioma.en < 0.6) return { id: 'cerebro', porque: `${fmtMB(s.bytes)} no entran en ningún contexto y el ${pct(1 - s.idioma.en)} no está en inglés` };
  return { id: 'tecnica', porque: `en inglés (${pct(s.idioma.en)}): el embedding en inglés alcanza` };
}

/** El uso al que se parece una config (o null: «a medida»). */
export function parecido(config, s) {
  return USOS.find((u) => u.firma(config, s))?.id ?? null;
}

/** La config que resulta de aplicar un uso sobre la vigente (los arrays se reemplazan). */
export function aplicarUso(vigente, uso, s, defaults) {
  return fusionar(vigente, uso.parche(s, vigente, defaults));
}

/** Mezcla profunda: los objetos se funden, lo demás (arrays incluidos) se reemplaza. */
export function fusionar(base, parche) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(parche)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' ? fusionar(out[k], v) : structuredClone(v);
  }
  return out;
}

/** Lo que cambia de `a` a `b`, como lista de [clave con puntos, antes, después]. */
export function diferencias(a, b, prefijo = '') {
  const out = [];
  for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    const x = a?.[k], y = b?.[k], clave = prefijo ? `${prefijo}.${k}` : k;
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) out.push(...diferencias(x, y, clave));
    else if (JSON.stringify(x) !== JSON.stringify(y)) out.push([clave, x, y]);
  }
  return out;
}

/** Sólo lo que cambió, como un objeto para fusionar en .mneme/config.json. */
export function parcheDe(dif) {
  const out = {};
  for (const [clave, , despues] of dif) {
    const partes = clave.split('.');
    let o = out;
    for (const p of partes.slice(0, -1)) o = o[p] ??= {};
    o[partes.at(-1)] = despues;
  }
  return out;
}

/**
 * Las reglas de `loadConfig` (src/config.js), para marcar una clave inválida mientras se edita.
 * ⚠️ Copia: el dueño es src/config.js. export.mjs compara esta copia contra el loadConfig real
 * con cada uso y avisa si divergen; en la app valida el servidor con loadConfig y esto se borra.
 * @returns {Array<[string, string]>}  [clave, motivo]
 */
export function validar(c, defaults) {
  const mal = [];
  const tipo = (a, b, clave) => {
    for (const k of Object.keys(a)) {
      const ck = clave ? `${clave}.${k}` : k;
      if (!(k in b)) { mal.push([ck, `unknown key "${ck}"`]); continue; }
      if (ck === 'embeddings.options') continue;
      const x = a[k], y = b[k];
      if (Array.isArray(y)) { if (!Array.isArray(x) || x.some((v) => typeof v !== 'string')) mal.push([ck, `"${ck}" must be a list of strings`]); }
      else if (y && typeof y === 'object') { if (!x || typeof x !== 'object' || Array.isArray(x)) mal.push([ck, `"${ck}" must be an object`]); else tipo(x, y, ck); }
      else if (typeof x !== typeof y || (typeof x === 'number' && !Number.isFinite(x))) mal.push([ck, `"${ck}" must be a ${typeof y}`]);
    }
  };
  tipo(c, defaults, '');
  if (mal.length) return mal;
  if (c.version !== 1) mal.push(['version', '"version" must be 1']);
  if (c.wakeUpBudget !== 0 && (!Number.isInteger(c.wakeUpBudget) || c.wakeUpBudget < 1024)) mal.push(['wakeUpBudget', '"wakeUpBudget" must be 0 (off) or a whole number of at least 1024 bytes']);
  const s = c.search, r = c.ranking, e = c.embeddings;
  if (s.minLexical < 0) mal.push(['search.minLexical', '"search.minLexical" must be a number of at least 0 (0 = off)']);
  if (!(s.minLexicalRatio > 0 && s.minLexicalRatio <= 1)) mal.push(['search.minLexicalRatio', '"search.minLexicalRatio" must be more than 0 and at most 1']);
  if (s.minCosine < -1 || s.minCosine > 1) mal.push(['search.minCosine', '"search.minCosine" must be a number between -1 and 1']);
  if (!['none', 'ollama', 'module'].includes(e.provider)) mal.push(['embeddings.provider', '"embeddings.provider" must be "none", "ollama" or "module"']);
  if (e.provider === 'module' && e.module.trim() === '') mal.push(['embeddings.module', '"embeddings.module" must name the file that exports createEmbedder when the provider is "module"']);
  if (c.guard !== 'deny' && c.guard !== 'record') mal.push(['guard', '"guard" must be "deny" or "record"']);
  if (r.k1 < 0) mal.push(['ranking.k1', '"ranking.k1" must be a number of at least 0']);
  if (r.b < 0 || r.b > 1) mal.push(['ranking.b', '"ranking.b" must be a number between 0 and 1']);
  if (!(r.rrfK > 0)) mal.push(['ranking.rrfK', '"ranking.rrfK" must be a number above 0']);
  return mal;
}

/** Qué formas del catálogo usa una config (para encenderlas): las que dependen de ella. */
export function usa(c, s) {
  const on = new Set(['rag', 'contextual', 'agentica', 'bm25']);
  if (c.wakeUpBudget > 0) on.add('cag').add('capas');
  if (s.vencen > 0) on.add('temporal');
  const p = c.embeddings.provider;
  if (p !== 'none') on.add('rrf');
  if (p === 'module') on.add('api');
  if (p === 'ollama') on.add(MULTILINGUE.test(c.embeddings.model) ? 'multilingue' : 'ingles');
  return on;
}

/** Si pasar de `a` a `b` cambia los vectores (y medirlo reindexaría). Apagar el embedder no. */
export function cambiaEmbedder(a, b) {
  if (b.embeddings.provider === 'none') return false;
  const id = (c) => JSON.stringify([c.embeddings.provider, c.embeddings.model, c.embeddings.module, c.embeddings.queryPrefix, c.embeddings.documentPrefix, c.embeddings.url]);
  return id(a) !== id(b);
}

const pct = (x) => `${Math.round(x * 100)} %`;
const fmtMB = (b) => `${(b / 1048576).toFixed(1).replace('.', ',')} MB`;
