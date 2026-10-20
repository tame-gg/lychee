const osNames = { darwin: 'mac', mas: 'mac', win32: 'win', linux: 'linux' }

export function netdTarget(electronPlatformName, arch) {
  const os = osNames[electronPlatformName]
  if (!os) throw new Error(`lychee-netd has no build for platform ${electronPlatformName}`)
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`lychee-netd has no build for ${electronPlatformName} ${arch}`)
  }
  return `${os}-${arch}`
}

export function netdBinaryName(electronPlatformName) {
  return electronPlatformName === 'win32' ? 'lychee-netd.exe' : 'lychee-netd'
}
