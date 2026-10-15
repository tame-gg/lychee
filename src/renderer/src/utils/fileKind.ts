export type FileKind =
  'video' | 'audio' | 'archive' | 'document' | 'program' | 'image' | 'torrent' | 'disk' | 'other'

export const FILE_KINDS: { kind: FileKind; label: string }[] = [
  { kind: 'video', label: 'Video' },
  { kind: 'audio', label: 'Audio' },
  { kind: 'archive', label: 'Archives' },
  { kind: 'document', label: 'Documents' },
  { kind: 'program', label: 'Programs' },
  { kind: 'image', label: 'Images' },
  { kind: 'torrent', label: 'Torrents' },
  { kind: 'disk', label: 'Disk images' },
  { kind: 'other', label: 'Other' }
]

const EXTENSIONS: Record<Exclude<FileKind, 'other'>, string[]> = {
  video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'm2ts', '3gp'],
  audio: ['mp3', 'flac', 'wav', 'aac', 'ogg', 'oga', 'm4a', 'wma', 'opus', 'aiff', 'mid'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz', 'cab'],
  document: [
    'pdf',
    'doc',
    'docx',
    'xls',
    'xlsx',
    'ppt',
    'pptx',
    'txt',
    'rtf',
    'odt',
    'ods',
    'odp',
    'epub',
    'mobi',
    'csv',
    'md',
    'pages',
    'numbers',
    'key'
  ],
  program: [
    'exe',
    'msi',
    'dmg',
    'pkg',
    'deb',
    'rpm',
    'appimage',
    'apk',
    'app',
    'bat',
    'sh',
    'jar',
    'msix',
    'xip'
  ],
  image: [
    'jpg',
    'jpeg',
    'png',
    'gif',
    'webp',
    'svg',
    'bmp',
    'tif',
    'tiff',
    'heic',
    'avif',
    'ico',
    'raw'
  ],
  torrent: ['torrent'],
  disk: ['iso', 'img', 'vhd', 'vhdx', 'vmdk', 'qcow2', 'cue', 'nrg']
}

const BY_EXTENSION = new Map<string, FileKind>(
  Object.entries(EXTENSIONS).flatMap(([kind, list]) =>
    list.map((extension): [string, FileKind] => [extension, kind as FileKind])
  )
)

export function fileKind(name: string): FileKind {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return 'other'
  return BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) ?? 'other'
}

export function kindOfDownload(item: { kind: 'http' | 'torrent'; fileName: string }): FileKind {
  return item.kind === 'torrent' ? 'torrent' : fileKind(item.fileName)
}
