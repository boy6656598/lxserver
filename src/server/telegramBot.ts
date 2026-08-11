import * as path from 'node:path'
import * as fs from 'node:fs'
import { Bot } from 'grammy'
import * as account from './userAccount'
import * as fileCache from './fileCache'
import * as serverDownloadQueue from './serverDownloadQueue'
import { parsePlaylistContent, normalizeTitle } from './playlistParser'
import type { ParsedSong, PlaylistParseResult } from './playlistParser'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const musicSdkRaw = require('@/modules/utils/musicSdk/index.js')
const musicSdk = musicSdkRaw as any
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getUserSpace } = require('@/user')

const TG_PLAYLIST_NAME = 'TG 歌单'
const MAX_PLAYLIST_SONGS = 200
const QUEUE_WAIT_TIMEOUT = 10 * 60 * 1000

let bot: Bot | null = null

const log = (msg: string): void => console.log(`[TelegramBot] ${msg}`)

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const escapeHtml = (value: unknown): string => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')

const parseArgs = (text: string): string[] => String(text || '').trim().split(/\s+/)

const HELP_TEXT = [
  '<b>LX Music 服务器助手</b>',
  '',
  '/register &lt;用户名&gt; &lt;密码&gt; &lt;卡密&gt; - 使用卡密注册并绑定账号',
  '/bind &lt;用户名&gt; &lt;密码&gt; - 绑定已注册账号',
  '/changepassword &lt;旧密码&gt; &lt;新密码&gt; - 修改密码',
  '/server - 获取服务器连接信息',
  '/status - 查看账号状态',
  '',
  '发送文本歌单（每行 <code>歌手 - 歌名</code>）、LX Music 歌单文件或平台歌单链接即可自动下载。',
].join('\n')

const NOT_BOUND_TEXT = '请先绑定账号：发送 <code>/register 用户名 密码 卡密</code> 注册，或 <code>/bind 用户名 密码</code> 绑定已有账号。'

const getBoundUsername = (telegramId: number): string | null => account.findUserByTelegramId(telegramId)

const requireBound = (telegramId: number): string | null => {
  const username = getBoundUsername(telegramId)
  if (!username) return null
  const access = account.checkUserAccess(username)
  if (!access.ok) return null
  return username
}

const formatExpire = (expireAt: number | null): string => {
  if (expireAt === null || expireAt === undefined) return '永久'
  const days = Math.ceil((expireAt - Date.now()) / 86400000)
  if (days < 0) return `已到期（${new Date(expireAt).toLocaleDateString('zh-CN')}）`
  return `${days} 天（${new Date(expireAt).toLocaleDateString('zh-CN')}）`
}

// ============ 本地曲库对比 ============

const buildLocalLibraryIndex = (): Set<string> => {
  const set = new Set<string>()
  const usernames = new Set<string>(['_open'])
  for (const user of global.lx.config.users || []) usernames.add(user.name)
  for (const username of usernames) {
    for (const loc of ['data', 'root']) {
      try {
        const items = fileCache.indexManager.getAll(username, 'music', loc)
        for (const item of items) {
          const key = normalizeTitle(`${item.singer}-${item.name}`)
          if (key) set.add(key)
        }
      } catch (err: any) {
        log(`Failed to read music index for ${username}/${loc}: ${err?.message || err}`)
      }
    }
  }
  return set
}

// ============ 歌曲搜索 ============

const resolveSongInfo = async (song: ParsedSong): Promise<any | null> => {
  if (song.source && song.songmid) {
    return { ...song }
  }
  try {
    const results = await musicSdk.findMusic({
      name: song.name,
      singer: song.singer,
      interval: song.interval || '',
      source: '',
    })
    return results && results.length ? results[0] : null
  } catch (err: any) {
    log(`Search failed for "${song.singer} - ${song.name}": ${err?.message || err}`)
    return null
  }
}

// ============ 下载等待 ============

const waitQueueDone = async (
  username: string,
  taskIds: Set<string>,
  timeoutMs = QUEUE_WAIT_TIMEOUT,
): Promise<any[]> => {
  const start = Date.now()
  const finished = new Set(['finished', 'exists', 'error', 'paused'])
  while (Date.now() - start < timeoutMs) {
    const tasks = serverDownloadQueue.list(username).filter(task => taskIds.has(task.id))
    if (tasks.length && tasks.every(task => finished.has(task.status))) return tasks
    await sleep(1500)
  }
  return serverDownloadQueue.list(username).filter(task => taskIds.has(task.id))
}

// ============ TG 歌单生成 ============

const updateTgPlaylist = async (username: string, songInfos: any[]): Promise<void> => {
  if (!songInfos.length) return
  const userSpace = getUserSpace(username)
  const listData = await userSpace.listManage.getListData()
  let tgList = listData.userList.find((list: any) => list.name === TG_PLAYLIST_NAME)
  if (!tgList) {
    const id = `tg_${Date.now()}`
    await userSpace.listManage.listDataManage.userListCreate({
      name: TG_PLAYLIST_NAME,
      id,
      source: 'wy',
      position: 0,
      locationUpdateTime: Date.now(),
    })
    tgList = { id }
  }
  await userSpace.listManage.listDataManage.listMusicAdd(tgList.id, songInfos, 'bottom')
  await userSpace.listManage.createSnapshot()
}

// ============ 歌单处理流程 ============

const handlePlaylist = async (chatId: number, username: string, parsed: PlaylistParseResult): Promise<void> => {
  if (!bot) return
  if (!parsed.songs.length) {
    await bot.api.sendMessage(chatId, '歌单解析失败：没有解析到任何歌曲，请检查格式。')
    return
  }

  const localSet = buildLocalLibraryIndex()
  const missing: ParsedSong[] = []
  for (const song of parsed.songs) {
    const key = normalizeTitle(`${song.singer}-${song.name}`)
    if (localSet.has(key)) continue
    missing.push(song)
  }

  const total = parsed.songs.length
  const existsCount = total - missing.length

  if (!missing.length) {
    await bot.api.sendMessage(chatId, `歌单处理完成：共 ${total} 首，全部已存在于服务器曲库，无需下载。`)
    return
  }

  await bot.api.sendMessage(
    chatId,
    `开始处理歌单：共 ${total} 首，本地已存在 ${existsCount} 首，${missing.length} 首将搜索并入队下载...`,
  )

  const limited = missing.slice(0, MAX_PLAYLIST_SONGS)
  const resolvedList: any[] = []
  let searchFail = 0
  for (const song of limited) {
    const info = await resolveSongInfo(song)
    if (info) resolvedList.push(info)
    else searchFail++
  }

  if (!resolvedList.length) {
    await bot.api.sendMessage(chatId, '无法在音乐源中找到任何缺失歌曲，已取消下载。')
    return
  }

  const tasks = serverDownloadQueue.enqueue(
    username,
    resolvedList.map(songInfo => ({ songInfo, quality: '320k' })),
  )
  const taskIds = new Set(tasks.map(task => task.id))

  await bot.api.sendMessage(
    chatId,
    `已加入下载队列 ${tasks.length} 首${searchFail ? `（另有 ${searchFail} 首搜索失败）` : ''}，下载完成后将汇总结果并生成「${TG_PLAYLIST_NAME}」歌单。`,
  )

  void (async () => {
    try {
      const finished = await waitQueueDone(username, taskIds)
      const stat = { finished: 0, exists: 0, error: 0, paused: 0 }
      const okSongInfos: any[] = []
      for (const task of finished) {
        const status = task.status as string
        if (Object.prototype.hasOwnProperty.call(stat, status)) (stat as any)[status]++
        if (task.status === 'finished' || task.status === 'exists') okSongInfos.push(task.songInfo)
      }
      try {
        await updateTgPlaylist(username, okSongInfos)
      } catch (err: any) {
        log(`Failed to update TG playlist for ${username}: ${err?.message || err}`)
      }
      const lines = [
        '<b>歌单处理完成</b>',
        `共 ${total} 首 · 已存在 ${existsCount} · 新下载 ${stat.finished} · 失败 ${stat.error}${stat.paused ? ` · 暂停 ${stat.paused}` : ''}`,
      ]
      if (okSongInfos.length) lines.push(`已更新「${TG_PLAYLIST_NAME}」歌单（${okSongInfos.length} 首）。`)
      await bot?.api.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' })
    } catch (err: any) {
      log(`Playlist processing error for ${username}: ${err?.message || err}`)
      await bot?.api.sendMessage(chatId, `歌单处理出错：${err?.message || err}`)
    }
  })()
}

const isPlaylistLink = (text: string): boolean => /music\.163\.com|y\.qq\.com|i\.y\.qq\.com/.test(text)

// ============ 命令处理 ============

const setupCommands = (botInstance: Bot): void => {
  botInstance.command('start', async ctx => {
    const from = ctx.from
    if (!from) return
    const username = getBoundUsername(from.id)
    const prefix = username ? `当前已绑定账号：<b>${escapeHtml(username)}</b>\n\n` : ''
    await ctx.reply(prefix + HELP_TEXT, { parse_mode: 'HTML' })
  })

  botInstance.command('register', async ctx => {
    const from = ctx.from
    if (!from) return
    const args = parseArgs(ctx.match)
    if (args.length < 3) {
      await ctx.reply('用法：/register &lt;用户名&gt; &lt;密码&gt; &lt;卡密&gt;', { parse_mode: 'HTML' })
      return
    }
    const username = args[0]
    const password = args[1]
    const cardCode = args[2]
    const result = account.registerUserAccount(username, password, cardCode, from.id)
    if (result.success) {
      await ctx.reply(`注册成功！已自动绑定 Telegram 账号。\n用户名：<code>${escapeHtml(username)}</code>`, { parse_mode: 'HTML' })
    } else {
      await ctx.reply(`注册失败：${escapeHtml(result.message)}`, { parse_mode: 'HTML' })
    }
  })

  botInstance.command('bind', async ctx => {
    const from = ctx.from
    if (!from) return
    const args = parseArgs(ctx.match)
    if (args.length < 2) {
      await ctx.reply('用法：/bind &lt;用户名&gt; &lt;密码&gt;', { parse_mode: 'HTML' })
      return
    }
    const result = account.bindTelegram(args[0], args[1], from.id)
    await ctx.reply(result.success ? '绑定成功！' : `绑定失败：${escapeHtml(result.message)}`, { parse_mode: 'HTML' })
  })

  botInstance.command('changepassword', async ctx => {
    const from = ctx.from
    if (!from) return
    const username = requireBound(from.id)
    if (!username) {
      await ctx.reply(NOT_BOUND_TEXT, { parse_mode: 'HTML' })
      return
    }
    const args = parseArgs(ctx.match)
    if (args.length < 2) {
      await ctx.reply('用法：/changepassword &lt;旧密码&gt; &lt;新密码&gt;', { parse_mode: 'HTML' })
      return
    }
    const result = account.changePassword(username, args[0], args[1])
    await ctx.reply(result.success ? '密码修改成功！' : `修改失败：${escapeHtml(result.message)}`, { parse_mode: 'HTML' })
  })

  botInstance.command('server', async ctx => {
    const from = ctx.from
    if (!from) return
    const username = requireBound(from.id)
    if (!username) {
      await ctx.reply(NOT_BOUND_TEXT, { parse_mode: 'HTML' })
      return
    }
    const publicUrl = String(global.lx.config['server.publicUrl'] || '').trim()
    if (!publicUrl) {
      await ctx.reply('服务器未配置对外地址，请联系管理员设置「服务器对外地址」。')
      return
    }
    const lines = [
      '<b>服务器连接信息</b>',
      '',
      `用户名：<code>${escapeHtml(username)}</code>`,
    ]
    const hasWebdav = global.lx.config['webdav.enable'] === true
    const subsonicPath = String(global.lx.config['subsonic.path'] || '/rest')
    if (hasWebdav) {
      lines.push(`WebDAV 地址：<code>${escapeHtml(publicUrl.replace(/\/+$/, ''))}/dav/${escapeHtml(username)}</code>`)
    } else {
      lines.push(`Subsonic 地址：<code>${escapeHtml(publicUrl.replace(/\/+$/, '') + subsonicPath)}</code>`)
    }
    lines.push('')
    lines.push('使用支持 Subsonic 协议的客户端（如音流、Syncthing 类播放器）配置上述信息即可使用。')
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
  })

  botInstance.command('status', async ctx => {
    const from = ctx.from
    if (!from) return
    const username = getBoundUsername(from.id)
    if (!username) {
      await ctx.reply(NOT_BOUND_TEXT, { parse_mode: 'HTML' })
      return
    }
    const info = account.getUserAccount(username)
    if (!info) {
      await ctx.reply('账号不存在。')
      return
    }
    const access = account.checkUserAccess(username)
    const statusText = info.banned ? '已封禁' : (info.expireAt !== null && Date.now() > info.expireAt ? '已到期' : '正常')
    const minutes = Math.round((info.activeSeconds || 0) / 60)
    const lines = [
      `<b>账号状态</b>`,
      `用户名：<code>${escapeHtml(username)}</code>`,
      `状态：${statusText}`,
      `有效期：${formatExpire(info.expireAt)}`,
      `上次活跃：${info.lastActiveAt ? new Date(info.lastActiveAt).toLocaleString('zh-CN') : '从未'}`,
      `本周期活跃：${minutes} 分钟`,
      `访问校验：${access.ok ? '通过' : escapeHtml(access.reason)}`,
    ]
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
  })

  // 未绑定用户仅允许 start/register/bind
  botInstance.use(async (ctx, next) => {
    const from = ctx.from
    if (!from) return
    if (ctx.message?.text && /^\/(start|register|bind)(\s|$)/.test(ctx.message.text)) return next()
    const username = requireBound(from.id)
    if (!username) return ctx.reply(NOT_BOUND_TEXT, { parse_mode: 'HTML' })
    return next()
  })

  botInstance.on('message:text', async ctx => {
    const from = ctx.from
    if (!from) return
    const username = requireBound(from.id)
    if (!username) return
    const text = ctx.message.text
    if (isPlaylistLink(text)) {
      const parsed = await parsePlaylistContent({ url: text.trim() })
      await handlePlaylist(ctx.chat.id, username, parsed)
      return
    }
    const parsed = await parsePlaylistContent({ text })
    await handlePlaylist(ctx.chat.id, username, parsed)
  })

  botInstance.on('message:document', async ctx => {
    const from = ctx.from
    if (!from) return
    const username = requireBound(from.id)
    if (!username) return
    try {
      const file = await ctx.getFile()
      const fileUrl = (file as any).getUrl()
      const resp = await new Promise<any>((resolve, reject) => {
        const { httpFetch } = require('@/modules/utils/request.js')
        const requestObj = httpFetch(fileUrl, { method: 'get', timeout: 60000 })
        requestObj.promise.then(resolve, reject)
      })
      const content = typeof resp?.body === 'string' ? resp.body : JSON.stringify(resp?.body || '')
      let parsed = await parsePlaylistContent({ lxJson: content })
      if (!parsed.songs.length) {
        parsed = await parsePlaylistContent({ text: content })
      }
      await handlePlaylist(ctx.chat.id, username, parsed)
    } catch (err: any) {
      await ctx.reply(`文件解析失败：${err?.message || err}`)
    }
  })
}

// ============ 初始化 ============

/**
 * 向配置的 TG 群组/用户发送管理通知（注册、封禁、到期等）
 */
export const notify = async (text: string): Promise<void> => {
  if (!bot) return
  const chatId = String(global.lx.config['telegram.chatId'] || '').trim()
  if (!chatId) return
  try {
    await bot.api.sendMessage(chatId, String(text || ''), { parse_mode: 'HTML' })
  } catch (err: any) {
    log(`Notify failed: ${err?.message || err}`)
  }
}

export const initTelegramBot = (): void => {
  const enabled = global.lx.config['telegram.enable'] === true
  const botToken = String(global.lx.config['telegram.botToken'] || '').trim()
  if (!enabled || !botToken) {
    log(`Skipped (enable=${enabled}, token=${botToken ? 'set' : 'empty'})`)
    return
  }
  try {
    const botInstance = new Bot(botToken)
    bot = botInstance
    setupCommands(botInstance)
    void botInstance.start({
      onStart: botInfo => log(`Started as @${botInfo.username}`),
    })
    botInstance.catch(err => {
      log(`Bot error: ${err?.message || err}`)
    })
  } catch (err: any) {
    log(`Failed to start bot: ${err?.message || err}`)
  }
}
