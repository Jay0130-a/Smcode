import { readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const testDir = path.join(root, 'test')
const entries = await readdir(testDir)
const testFiles = entries
  .filter(name => name.endsWith('.test.ts'))
  .sort()
  .map(name => path.join(testDir, name))

if (testFiles.length === 0) {
  console.error('No test files found in test/*.test.ts')
  process.exit(1)
}

// `npm run test:coverage` 透传 `--coverage`，启用 Node 原生 v8 覆盖率统计
// （--experimental-test-coverage 在 Node 20/22 可用，Node 24 中为稳定别名）
const withCoverage = process.argv.includes('--coverage')

const nodeArgs = ['--import', 'tsx']
if (withCoverage) {
  nodeArgs.push('--experimental-test-coverage')
}
nodeArgs.push('--test', ...testFiles)

const child = spawn(process.execPath, nodeArgs, { stdio: 'inherit' })

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 1)
})
