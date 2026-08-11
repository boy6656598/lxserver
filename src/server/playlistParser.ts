let _musicSdk: any = null
const getMusicSdk = (): any => {
  if (!_musicSdk) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _musicSdk = require('@/modules/utils/musicSdk/index.js')
  }
  return _musicSdk
}

export interface ParsedSong {
  name: string
  singer: string
  albumName?: string
  interval?: string
  source?: string
  songmid?: string
  img?: string
}

export type PlaylistSource = 'text' | 'lx-json' | 'platform-link'

export interface PlaylistParseResult {
  source: PlaylistSource
  rawCount: number
  songs: ParsedSong[]
}

// 歌手 - 歌名 分隔符（中英文短横线 / 破折号）
const SPLITTER_RE = /^(.+?)\s*(?:-|–|—)\s*(.+)$/

const cleanLine = (line: string): string => String(line || '').replace(/^\s+|\s+$/g, '')

/**
 * 归一化标题用于曲库对比：转小写并去除空白与标点
 */
export const normalizeTitle = (value: unknown): string => String(value || '')
  .toLowerCase()
  .replace(/[\s'·.!+,，&"、()（）`~\-<>|\/\[\]!！？?]/g, '')

/**
 * 解析文本歌单：每行 `歌手 - 歌名`，无分隔符时按整行歌名处理
 */
export const parseTextPlaylist = (text: string): ParsedSong[] => {
  const lines = String(text || '').split(/\r?\n/)
  const songs: ParsedSong[] = []
  for (const raw of lines) {
    const line = cleanLine(raw)
    if (!line || line.startsWith('#')) continue
    const m = SPLITTER_RE.exec(line)
    if (m) {
      songs.push({ singer: cleanLine(m[1]), name: cleanLine(m[2]) })
    } else {
      songs.push({ singer: '', name: line })
    }
  }
  return songs
}

const formatSinger = (singer: unknown): string => {
  if (Array.isArray(singer)) return singer.join(' / ')
  return String(singer || '')
}

/**
 * 解析 LX Music JSON 歌单：直接读取 list 数组
 */
export const parseLxJsonPlaylist = (content: string): ParsedSong[] => {
  let data: any
  try {
    data = JSON.parse(content)
  } catch {
    return []
  }
  const list = Array.isArray(data) ? data : (Array.isArray(data?.list) ? data.list : null)
  if (!list) return []
  const songs: ParsedSong[] = []
  for (const item of list) {
    if (!item || !item.name) continue
    const songmid = item.songmid ? String(item.songmid) : (item.id ? String(item.id) : undefined)
    songs.push({
      name: String(item.name),
      singer: formatSinger(item.singer),
      albumName: item.albumName ? String(item.albumName) : undefined,
      interval: item.interval ? String(item.interval) : undefined,
      source: item.source || undefined,
      songmid,
      img: item.img || undefined,
    })
  }
  return songs
}

const WY_PLAYLIST_RE = /music\.163\.com[^\s]*?(?:(?:#\/)?(?:my)?playlist\?id=|playlist\/|playlist\?id=)(\d+)/
const TX_PLAYLIST_RE = /(?:y\.qq\.com|i\.y\.qq\.com)[^\s]*?(?:playlist\/|dissid=|id=)(\d+)/

const toParsedSongs = (list: any[], source: string): ParsedSong[] => (list || [])
  .map(item => ({
    name: String(item.name || ''),
    singer: formatSinger(item.singer),
    albumName: item.albumName ? String(item.albumName) : undefined,
    interval: item.interval ? String(item.interval) : undefined,
    source: item.source || source,
    songmid: item.songmid ? String(item.songmid) : undefined,
    img: item.img || undefined,
  }))
  .filter(song => song.name)

/**
 * 解析平台歌单链接（网易云 / QQ 音乐）
 */
export const parsePlatformLink = async (url: string): Promise<ParsedSong[]> => {
  const wyMatch = WY_PLAYLIST_RE.exec(url || '')
  if (wyMatch) {
    try {
      const musicSdk = getMusicSdk()
      const res = await musicSdk.wy.songList.getListDetail(wyMatch[1], 1)
      return Array.isArray(res?.list) ? toParsedSongs(res.list, 'wy') : []
    } catch (err: any) {
      console.warn('[PlaylistParser] WY playlist fetch failed:', err?.message || err)
      return []
    }
  }
  const txMatch = TX_PLAYLIST_RE.exec(url || '')
  if (txMatch) {
    try {
      const musicSdk = getMusicSdk()
      const res = await musicSdk.tx.songList.getListDetail(txMatch[1])
      return Array.isArray(res?.list) ? toParsedSongs(res.list, 'tx') : []
    } catch (err: any) {
      console.warn('[PlaylistParser] TX playlist fetch failed:', err?.message || err)
      return []
    }
  }
  return []
}

/**
 * 统一歌单解析入口
 */
export const parsePlaylistContent = async (input: {
  text?: string
  lxJson?: string
  url?: string
}): Promise<PlaylistParseResult> => {
  if (input.url) {
    const songs = await parsePlatformLink(input.url)
    return { source: 'platform-link', rawCount: songs.length, songs }
  }
  if (input.lxJson) {
    const songs = parseLxJsonPlaylist(input.lxJson)
    return { source: 'lx-json', rawCount: songs.length, songs }
  }
  const songs = parseTextPlaylist(input.text || '')
  return { source: 'text', rawCount: songs.length, songs }
}
