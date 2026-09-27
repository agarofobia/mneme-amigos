# Cómo hacer tu propio pack (la piel de la galaxia)

Un **pack** cambia cómo se ve Mneme en la galaxia (`mneme galaxia`): los colores y las letras de la
interfaz, el fondo del espacio, las nebulosas, las estrellas, las líneas, los colores de los grupos y
los de cada sesión. No cambia nada de tus notas ni de cómo funciona Mneme: es sólo la piel.

Un pack es **una carpeta con datos**: un `pack.json`, y, si quieres, una hoja de estilo y fuentes.
**Nunca lleva un programa**: Mneme lo revisa antes de usarlo y rechaza cualquier cosa que pueda correr
código o traer algo de internet (abajo, «Lo que se rechaza»).

## La forma más fácil: desde la galaxia

1. Abre la galaxia: `mneme galaxia` (o «Abrir Mneme» en tu espacio de trabajo).
2. Ve a **opciones** → **apariencia · los packs**. Ahí están todos: los de fábrica y los tuyos.
3. Escribe un nombre (minúsculas, dígitos y guiones: `mi-pack`) y una línea que diga qué es, y pulsa
   **crear con lo que ves**. Se crea tu pack con todos los valores de lo que estás viendo, y queda elegido.
4. Ajústalo con el **ajuste fino** (más abajo en opciones: brillo de la nebulosa, líneas, luz, acento,
   tamaño del texto…) y pulsa **guardar el ajuste fino en «mi-pack»**.
5. Para cambiar lo que el ajuste fino no tiene (el fondo, las nebulosas, los colores de los grupos), edita
   el `pack.json` a mano: **copiar la carpeta de tus packs** te da dónde está. Guardas y recargas la página.

Borrar un pack tuyo lo manda a la papelera (`.papelera`, en la misma carpeta): se puede recuperar.
Los packs de fábrica no se pueden borrar ni sobrescribir; para partir de uno, elígelo y pulsa **crear con lo que ves**.

## Dónde viven

- **Los tuyos:** en la carpeta de packs de Mneme (Windows: `C:\Users\<tu usuario>\.config\mneme\packs\`),
  uno por carpeta: `packs\mi-pack\pack.json`. **El nombre de la carpeta y el `"name"` del pack.json
  tienen que ser iguales.**
- **Los de fábrica:** en la carpeta `packs\` de donde instalaste Mneme (por ejemplo `cianotipo`).
  Mira `packs\cianotipo\pack.json` como ejemplo: sólo tokens y escena, sin CSS.
- Para probar uno sin elegirlo: agrega `?pack=mi-pack` a la dirección de la galaxia.

## El pack.json

```json
{
  "packFormat": 2,
  "name": "mi-pack",
  "version": "0.1.0",
  "description": "Qué es, en una línea.",
  "author": "tu nombre",
  "license": "MIT",
  "extends": "cianotipo",
  "tokens": { "--acento": "#9fd3f0" },
  "escena": { "cielo": { "intensidad": 0.6 } },
  "styles": ["pack.css"],
  "assets": { "mi-letra": "fuentes/mi-letra.woff2" }
}
```

| Campo | Qué es |
|---|---|
| `packFormat` | Siempre `2` para la galaxia (el `1` es de la página vieja, `mneme gui`). |
| `name` | Minúsculas, dígitos y guiones. Igual que el nombre de la carpeta. |
| `version`, `description`, `author`, `license` | Para ti y para quien lo reciba. `version` es obligatorio. |
| `extends` | Opcional: el nombre de otro pack de formato 2. Partes de ese y reemplazas sólo lo que cambias. |
| `tokens` | Los colores, letras y medidas de la interfaz (tabla de abajo). **Pon sólo los que cambias.** |
| `escena` | Lo que dibuja el espacio (tabla de abajo). También sólo lo que cambias. |
| `styles` | Opcional: hojas `.css` de la carpeta, para lo que los tokens no alcanzan. |
| `assets` | Opcional: fuentes o imágenes de la carpeta, con un nombre para usarlas desde el CSS. |

Lo que no nombras queda como en la piel de base (la **cámara oscura**).

## Los tokens (la interfaz)

Van en `"tokens"`. Son variables de CSS: el valor es cualquier valor de CSS **sin** `;`, `{`, `}`, `<`, `>`
ni `url(`.

**Colores**

| Token | Qué pinta | Base |
|---|---|---|
| `--fondo` | El fondo de la página (detrás del espacio y mientras carga) | `#070605` |
| `--tinta` | El texto principal | `#ECE5D8` |
| `--tinta-2` | El texto secundario | tinta al 62 % |
| `--tinta-3` | Lo más tenue: aclaraciones, rótulos | tinta al 36 % |
| `--acento` | Lo elegido, el foco, los enlaces, los avisos | `#F3C27A` |
| `--filete` | Las líneas finas que separan | tinta al 13 % |
| `--vineta` | La sombra que despega la partitura del espacio | fondo al 88 % |
| `--velo-rgb` | El color del velo del menú y del primer paso, **en R, G, B** (ej.: `7, 6, 5`) | `7, 6, 5` |
| `--etiqueta` | Los nombres de las notas flotando en el espacio | tinta al 82 % |
| `--sombra-texto` | La sombra que despega el texto del espacio (en un pack claro, clara) | `#000` |
| `--superficie` | El fondo del código, del editor y del mensaje del primer paso | tinta al 5 % |
| `--ventana-fondo` | El fondo de las ventanas (la nota, el primer paso) | casi negro al 90 % |
| `--ventana-borde` | El borde de las ventanas | tinta al 12 % |
| `--ventana-sombra` | La sombra de las ventanas (un `box-shadow`) | `0 30px 90px …` |

**Letras**

| Token | Qué es | Base |
|---|---|---|
| `--serif` | Los títulos y el texto de las notas | Alegreya |
| `--sans` | La interfaz | Alegreya Sans |
| `--sc` | Los rótulos en versalitas | Alegreya Sans SC |
| `--mono` | Horas, rutas, código | IBM Plex Mono |
| `--texto` | El tamaño del texto de la interfaz | `14px` |
| `--titulo` | El tamaño del nombre, arriba a la izquierda | `26px` |

**Medidas y velos**

| Token | Qué es | Base |
|---|---|---|
| `--borde` | El margen contra el borde de la pantalla | `28px` |
| `--velo-opacidad` | Qué tan oscuro es el velo detrás del menú abierto (0 a 1) | `.9` |
| `--velo-desenfoque` | Cuánto desenfoca el velo lo que hay detrás | `6px` |
| `--velo-ancho` | El ancho de la columna del menú | `520px` |
| `--ventana-radio` | Lo redondeado de las esquinas de las ventanas | `6px` |
| `--ventana-desenfoque` | Cuánto desenfocan las ventanas lo que tapan | `12px` |
| `--voz-alto` | El alto de cada fila de la partitura (una por sesión) | `9px` |

**El espacio** (son números; los lee el dibujo)

| Token | Qué es | Base |
|---|---|---|
| `--neb-brillo` | Cuánto brillan las nubes de cada nota | `1` |
| `--neb-absorcion` | Cuánto tapan lo que hay detrás | `.7` |
| `--neb-desenfoque` | El foco (más = menos borroso) | `110` |
| `--cuadro-tamano` | El tamaño de cada nota | `1` |
| `--linea-principal` | Qué tanto se ven las líneas principales | `.18` |
| `--linea-secundaria` | Las demás, como fracción de las principales | `.15` |
| `--linea-ancho` | El ancho del núcleo de cada línea, en px | `1.4` |
| `--linea-radio` | Cuánto alrededor de una luz se enciende la línea que recorre | `12` |
| `--linea-material` | La intensidad del material de las líneas (0 deja un hilo) | `1` |
| `--luz-ilumina` | Cuánto iluminan las luces de las sesiones | `.35` |
| `--halo` | El halo de las notas vistas de lejos | `1` |
| `--galaxia-brillo` | El brillo de las galaxias (con la forma «galaxias») | `1` |

## La escena (el espacio)

Va en `"escena"`. Sólo acepta **colores `#rrggbb`**, **números** y **listas** de eso. Si pones una
clave que el dibujo no conoce, la galaxia te lo avisa en opciones y usa el resto.

| Clave | Qué es | Base |
|---|---|---|
| `fondo` | El color del espacio | `#050403` |
| `cielo.intensidad` | Cuánto se ven las nebulosas y las ondas del fondo (0 las apaga) | `1.25` |
| `cielo.bajo`, `cielo.alto` | El degradado del fondo, de abajo hacia arriba | `#050403` → `#0c0907` |
| `cielo.calida`, `cielo.fria` | Los dos colores de nebulosa | `#160f09`, `#070d0f` |
| `cielo.onda` | El color de las ondas | `#060503` |
| `estrellas.cantidad` | Cuántas estrellas (0 a 5000) | `900` |
| `estrellas.color`, `estrellas.opacidad` | Su color y qué tanto se ven (0 a 1) | `#d8cbb4`, `0.42` |
| `linea` | El color del hilo de las líneas | `#D8CCBA` |
| `luz` | El color de la cabeza de cada luz que viaja | `#FFE6BE` |
| `tintes` | Los colores de los grupos de notas, en orden (se repiten si hay más grupos) | 7 tintes apagados |
| `voces` | Un color por sesión (en la partitura y en la estela de su luz) | 15 colores |
| `script` | El color de lo que escribe un script (notas generadas) | `#7E97A6` |
| `sinAutor` | El color de una escritura por fuera, sin autor | `#9A938A` |
| `sinSesion` | El color de una sesión que no está en la lista | `#8A847A` |

Consejo: los colores del cielo van **muy oscuros** (se suman encima del fondo). Empieza cerca de los de base.

## CSS y fuentes propias

Para lo que los tokens no alcanzan, un `pack.css` en la carpeta y `"styles": ["pack.css"]`. Algunos lugares
que se pueden vestir: `#tl` (el nombre y el menú), `#menu`, `#seccion` (la sección abierta), `.ventana`
(las ventanas), `.md` (el texto de una nota), `#partitura`, `#labels .l` (los nombres en el espacio).
**Atención:** la galaxia es una vista previa y estos nombres todavía pueden cambiar; lo estable son los tokens.

Una fuente propia viaja **dentro** del pack (no se permite traerla de internet):

```css
@font-face { font-family: "Mi Letra"; src: url("asset:mi-letra") format("woff2"); }
```

con `"assets": { "mi-letra": "fuentes/mi-letra.woff2" }` en el pack.json y `"--sans": "\"Mi Letra\", sans-serif"`
en los tokens. Se aceptan `.woff2`, `.woff`, `.ttf`, `.otf` e imágenes (`.png`, `.jpg`, `.webp`, `.gif`, `.svg`),
de hasta 2 MB cada una.

## Lo que se rechaza (y por qué)

Un pack puede venir de cualquiera, así que Mneme lo trata como algo que no es de fiar:

- **Archivos de programa** en la carpeta (`.js`, `.mjs`, `.html`, `.ps1`, `.bat`, `.exe`…): un pack es datos.
- En el CSS: `@import`, `javascript:`, `expression(`, `<script`, y **cualquier `url()` a internet**
  (podría avisarle a alguien cada vez que abres Mneme). Las fuentes e imágenes van en `assets`.
- En los tokens: valores con `;`, `{`, `}`, `<`, `>` o `url(` (podrían escaparse de su lugar).
- En la escena: cualquier cosa que no sea un color `#rrggbb`, un número o una lista de eso.
- Archivos fuera de la carpeta del pack, un `extends` a un pack de otro formato, o una cadena de más de 4.

Cuando algo se rechaza, opciones lo marca **no carga** y dice por qué; la galaxia sigue con la base.

## Lo que todavía no se puede

- **Un fondo claro (blanco).** Las notas y las luces **suman luz**: sobre blanco se pierden. Hasta que el
  dibujo tenga un modo claro, los packs van sobre fondos oscuros (pueden ser grises, azules, lo que quieras).
- Los colores de los materiales de las líneas (el celeste del polvo, el rojo de alarma) siguen fijos.

## Compartir un pack

Comprime la carpeta del pack (`mi-pack\`, con su `pack.json` dentro) y envíala. Quien la reciba la
descomprime en su carpeta de packs y la elige en opciones.
