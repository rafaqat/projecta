/**
 * Ignore rules for ingestion (UAT 2026-09-14). Generated, vendored and
 * packaged trees are recorded as files of the commit but never read,
 * chunked or embedded: a minified bundle carries nothing a citation should
 * rest on, and it is where the bulk of a repository's bytes and tokens go.
 *
 * Patterns follow the gitignore forms people already know, without
 * negation: a trailing `/` names a directory (anything under it), a `/`
 * elsewhere anchors the pattern at the repository root, otherwise it matches
 * at any depth; `*` and `?` stay within one path segment, `**` crosses them;
 * matching ignores case. The workspace's list for a repository replaces the
 * defaults when set.
 */
export const DEFAULT_IGNORE: readonly string[] = [
  // JavaScript and TypeScript
  'node_modules/',
  'bower_components/',
  '.yarn/',
  '.pnpm-store/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.nuxt/',
  '.turbo/',
  '.cache/',
  'coverage/',
  'storybook-static/',
  '*.min.js',
  '*.min.css',
  // Generated documentation bundles (jazzy, docsets): never source (UAT 2026-09-16, Sejima).
  '*.docset/',
  '*.bundle.js',
  '*.map',
  // Rails
  'vendor/',
  'tmp/',
  'log/',
  'storage/',
  'public/assets/',
  'public/packs/',
  'public/packs-test/',
  'public/build/',
  'public/js/',
  'public/css/',
  'public/vendor/',
  'public/vendors/',
  'public/plugins/',
  'public/lib/',
  'public/libs/',
  'public/fonts/',
  'public/images/',
  'public/img/',
  'app/assets/builds/',
  'vendors/',
  // Swift and Xcode
  'Pods/',
  'Carthage/',
  'DerivedData/',
  '.build/',
  '.swiftpm/',
  '*.xcodeproj/',
  '*.xcworkspace/',
  '*.xcassets/',
  // Android and Gradle
  '.gradle/',
  '.idea/',
  '.cxx/',
  'captures/',
  // General
  // Translation bundles: thousands of strings per file, nothing a code question cites.
  'locales/',
  'locale/',
  'i18n/',
  'translations/',
  '**/lang/*.json',
  '**/lang/*.yml',
  '.vscode/',
  '__pycache__/',
  '.venv/',
  'venv/',
  'target/',
  // Binary formats: nothing to cite, and not worth fetching to find that out.
  // Images
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.bmp',
  '*.ico',
  '*.tif',
  '*.tiff',
  '*.webp',
  '*.heic',
  '*.psd',
  '*.ai',
  '*.sketch',
  // Documents
  '*.pdf',
  '*.doc',
  '*.docx',
  '*.xls',
  '*.xlsx',
  '*.ppt',
  '*.pptx',
  '*.key',
  '*.pages',
  '*.numbers',
  // Fonts
  '*.ttf',
  '*.otf',
  '*.woff',
  '*.woff2',
  '*.eot',
  // Audio and video
  '*.mp3',
  '*.wav',
  '*.aac',
  '*.flac',
  '*.ogg',
  '*.mp4',
  '*.mov',
  '*.avi',
  '*.mkv',
  '*.webm',
  // Archives and packages
  '*.zip',
  '*.gz',
  '*.tgz',
  '*.tar',
  '*.bz2',
  '*.xz',
  '*.7z',
  '*.rar',
  '*.jar',
  '*.aar',
  '*.war',
  '*.apk',
  '*.aab',
  '*.ipa',
  '*.dmg',
  '*.pkg',
  '*.deb',
  '*.rpm',
  '*.nupkg',
  '*.gem',
  '*.whl',
  // Compiled and machine code
  '*.exe',
  '*.dll',
  '*.so',
  '*.dylib',
  '*.a',
  '*.lib',
  '*.o',
  '*.obj',
  '*.class',
  '*.pyc',
  '*.pyo',
  '*.wasm',
  '*.node',
  // Data, databases and model weights
  '*.sqlite',
  '*.sqlite3',
  '*.db',
  '*.realm',
  '*.parquet',
  '*.onnx',
  '*.safetensors',
  '*.pt',
  '*.pth',
  '*.h5',
  // Not `*.bin` or `*.dat`: generic names that text data files use too; the content sniff
  // at read time decides those (AC-WP03-04).
  '*.pb',
  '*.tflite',
  '*.mlmodel',
  '*.mlmodelc/',
]

export const MAX_IGNORE_PATTERNS = 200

/** One pattern, one line: no whitespace, no `..` segment, no negation, bounded length. */
const PATTERN = /^!?[^\s]{1,200}$/

interface Rule {
  source: string
  regex: RegExp
}

const compiled = new Map<string, Rule>()

function escape(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

/** gitignore-style glob to a regular expression over the whole path. */
function compile(source: string): Rule {
  const cached = compiled.get(source)
  if (cached) return cached
  let body = source
  const directory = body.endsWith('/')
  if (directory) body = body.slice(0, -1)
  const anchored = body.startsWith('/') || body.includes('/')
  if (body.startsWith('/')) body = body.slice(1)
  let pattern = ''
  for (let i = 0; i < body.length; i++) {
    if (body.startsWith('**/', i)) {
      pattern += '(?:.*/)?'
      i += 2
    } else if (body.startsWith('**', i)) {
      pattern += '.*'
      i += 1
    } else if (body[i] === '*') pattern += '[^/]*'
    else if (body[i] === '?') pattern += '[^/]'
    else pattern += escape(body[i])
  }
  // A directory matches what is under it; a file pattern matches the entry or what is under it.
  const tail = directory ? '/.+$' : '(?:/.*)?$'
  const head = anchored ? '^' : '(?:^|.*/)'
  // Case-insensitive: `Manual.PDF` and `IMG_001.JPG` are the same families as their lowercase
  // names, and the common file systems here (APFS, NTFS) do not distinguish case either.
  const rule = { source, regex: new RegExp(head + pattern + tail, 'i') }
  compiled.set(source, rule)
  return rule
}

/** The first pattern that ignores the path, or null. */
export function ignoredBy(path: string, patterns: readonly string[]): string | null {
  for (const source of patterns) if (compile(source).regex.test(path)) return source
  return null
}

/**
 * A user-supplied list, one pattern per line: trimmed, comments (`#`) and
 * blank lines dropped, duplicates removed, each pattern checked, at most
 * MAX_IGNORE_PATTERNS.
 */
export function parseIgnoreList(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (!PATTERN.test(line) || line.startsWith('!') || line.split('/').includes('..'))
      throw new Error(`not a valid ignore pattern: ${JSON.stringify(line)}`)
    if (!out.includes(line)) out.push(line)
  }
  if (out.length > MAX_IGNORE_PATTERNS)
    throw new Error(`at most ${MAX_IGNORE_PATTERNS} ignore patterns`)
  return out
}
