export const MAC_HELPER_DIR = '/Library/PrivilegedHelperTools'
export const MAC_HELPER = `${MAC_HELPER_DIR}/gg.tame.lychee.netd`
export const MAC_CONTROL = '/var/run/lychee-netd/netd.sock'
export const MAC_SUDOERS = '/etc/sudoers.d/lychee-netd'
export const MAC_LAUNCH_ARGS = ['serve', '--control', MAC_CONTROL] as const

const SUDOERS_USER = /^[A-Za-z0-9._-]+$/

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function macRootOwnedCopyLines(bundled: string): string[] {
  const temp = `${MAC_HELPER}.tmp`
  return [
    `/bin/mkdir -p ${shellQuote(MAC_HELPER_DIR)}`,
    `/usr/sbin/chown root:wheel ${shellQuote(MAC_HELPER_DIR)}`,
    `/bin/chmod 755 ${shellQuote(MAC_HELPER_DIR)}`,
    `/bin/cp ${shellQuote(bundled)} ${shellQuote(temp)}`,
    `/usr/sbin/chown root:wheel ${shellQuote(temp)}`,
    `/bin/chmod 755 ${shellQuote(temp)}`,
    `/bin/mv -f ${shellQuote(temp)} ${shellQuote(MAC_HELPER)}`
  ]
}

export function macSudoersContent(user: string): string {
  if (!SUDOERS_USER.test(user)) {
    throw new Error(`sudoers user ${JSON.stringify(user)} is not a simple account name`)
  }
  return (
    `# Written by Lychee: ${user} may start the network helper without a password.\n` +
    `${user} ALL=(root) NOPASSWD: ${MAC_HELPER} serve --control ${MAC_CONTROL}\n`
  )
}
