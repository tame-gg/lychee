import checkNetdPackage from './check-netd-package.mjs'
import checkTorrentPackage from './check-torrent-package.mjs'

export default async function afterPack(context) {
  await checkTorrentPackage(context)
  await checkNetdPackage(context)
}
