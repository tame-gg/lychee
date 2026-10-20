import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Arch } from 'electron-builder'
import { netdTarget } from './netd-target.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export default async function beforePack(context) {
  const target = netdTarget(context.electronPlatformName, Arch[context.arch])
  execFileSync('node', [join(root, 'scripts', 'build-netd.mjs'), '--target', target], {
    cwd: root,
    stdio: 'inherit'
  })
}
