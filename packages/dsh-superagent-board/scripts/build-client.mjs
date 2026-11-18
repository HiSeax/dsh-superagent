import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientPath = resolve(__dirname, '../lib/client.js')

const source = readFileSync(clientPath, 'utf8')

// If already wrapped, do nothing
if (source.includes('window.__ModuleLoader__.load')) {
  console.log('client.js already wrapped')
  process.exit(0)
}

const exportedNames = []
for (const match of source.matchAll(/^export\s+(?:const|function)\s+([a-zA-Z0-9_$]+)/gm)) {
  exportedNames.push(match[1])
}

// The ModuleLoader factory has no module system, so a shared-module import is inlined:
// the import line is replaced by the shared file's compiled source with `export` stripped.
const inlineImport = (transformed) => {
  const importMatch = transformed.match(/^import\s+\{[^}]+\}\s+from\s+['"]\.\/shared\/([a-z-]+)\.js['"];?/m)
  if (importMatch === null) return transformed
  const shared = readFileSync(resolve(__dirname, `../lib/shared/${importMatch[1]}.js`), 'utf8')
    .replace(/^export\s+/gm, '')
    .replace(/^\/\/# sourceMappingURL=.*$/m, '')
  return transformed.replace(importMatch[0], shared)
}

const transformed = inlineImport(source
  .replace(/^import\s+\{\s*([^}]+)\s*\}\s+from\s+['"]react['"];?/m, 'const { $1 } = require("react");')
  .replace(/^export\s+const\s+/gm, 'const ')
  .replace(/^export\s+function\s+/gm, 'function '))

const exportsList = exportedNames.length > 0 ? exportedNames.join(', ') : 'name, inject, BOARD_TAB_ID, apply'

const wrapped = `window.__ModuleLoader__.load({
  id: 'dsh-superagent-board',
  factory(require) {
${transformed.split('\n').map(line => '    ' + line).join('\n')}

    return { ${exportsList} };
  }
});
`

writeFileSync(clientPath, wrapped, 'utf8')
console.log('Successfully wrapped lib/client.js in window.__ModuleLoader__.load, exports:', exportsList)
