import * as fs from 'fs'
import * as http from 'http'
import * as https from 'https'

const MIME_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.ape': 'audio/x-ape',
  '.opus': 'audio/ogg',
  '.aac': 'audio/aac',
  '.wma': 'audio/x-ms-wma',
}

export const getAudioMime = (filePath: string): string => {
  const ext = pathExt(filePath).toLowerCase()
  return MIME_TYPES[ext] || 'audio/mpeg'
}

const pathExt = (filePath: string): string => {
  const idx = filePath.lastIndexOf('.')
  return idx >= 0 ? filePath.substring(idx) : ''
}

/**
 * 服务本地缓存文件（支持 Range 与 suffix range），返回是否已完整缓存
 */
export const serveLocalCacheFile = (filePath: string, range: string | undefined, res: http.ServerResponse): boolean => {
  if (!fs.existsSync(filePath)) return false
  const stat = fs.statSync(filePath)
  if (stat.size === 0) return false
  const contentType = getAudioMime(filePath)
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-')
    let start: number
    let end: number
    if (parts[0] === '') {
      const suffix = parseInt(parts[1], 10)
      if (!Number.isFinite(suffix) || suffix <= 0) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
        res.end()
        return true
      }
      start = Math.max(0, stat.size - suffix)
      end = stat.size - 1
    } else {
      start = parseInt(parts[0], 10)
      end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= stat.size || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
      res.end()
      return true
    }
    if (end >= stat.size) end = stat.size - 1
    const chunksize = (end - start) + 1
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    })
    fs.createReadStream(filePath, { start, end }).pipe(res)
    return true
  }
  res.writeHead(200, {
    'Content-Length': stat.size,
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  })
  fs.createReadStream(filePath).pipe(res)
  return true
}

export interface LocalStreamProxyOptions {
  cacheFilePath: string
  filePath: string
  stream: (range?: string) => Promise<http.ClientRequest>
  trackProgress?: (total: number, received: number) => void
  markCacheDone?: () => void
  clearCacheProgress?: () => void
  logTag?: string
}

/**
 * 服务端流式代理：本地缓存优先（秒开 + 拖拽），未缓存时经上游流式拉取，
 * 递归跟随 3xx 重定向（最多 5 跳），并边播边写缓存。
 * 供 Subsonic stream 处理器与内部 /api 下的流端点复用。
 */
export const proxyLocalStream = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: LocalStreamProxyOptions,
): Promise<void> => {
  const { cacheFilePath, filePath, logTag } = options
  const range = req.headers.range as string | undefined

  if (serveLocalCacheFile(cacheFilePath, range, res)) {
    console.log(`${logTag || '[Local]'} Cache hit: ${filePath}`)
    return
  }

  let proxyReq: http.ClientRequest
  try {
    proxyReq = await options.stream(range)
  } catch (err: any) {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: false, message: err?.message || 'Failed to open upstream stream' }))
    } else {
      res.end()
    }
    return
  }

  const handleStreamError = (err: any) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: false, message: err?.message || 'Stream error' }))
    } else {
      res.end()
    }
  }

  // 递归跟随 3xx 重定向（上游 /d/ 直链会 302 到对象存储/CDN），最多 5 跳
  const followRedirect = (currentReq: http.ClientRequest, hop = 0) => {
    currentReq.on('error', handleStreamError)
    currentReq.on('response', (resp: http.IncomingMessage) => {
      const statusCode = resp.statusCode || 200
      const location = resp.headers['location']
      if (hop < 5 && statusCode >= 300 && statusCode < 400 && location) {
        resp.resume()
        let targetUrl: URL
        try {
          targetUrl = new URL(location)
        } catch (e) {
          handleStreamError(new Error('非法重定向地址'))
          return
        }
        const lib = targetUrl.protocol === 'https:' ? https : http
        const redirectHeaders: Record<string, string> = {}
        const rangeHeader = String(req.headers.range || '')
        if (rangeHeader) redirectHeaders['Range'] = rangeHeader
        const nextReq = lib.request(targetUrl, { method: 'GET', headers: redirectHeaders } as any)
        nextReq.on('error', () => { /* 下一跳处理 */ })
        nextReq.end()
        followRedirect(nextReq, hop + 1)
        return
      }
      const outHeaders: Record<string, string | number> = {}
      let contentType = resp.headers['content-type'] ? String(resp.headers['content-type']).split(';')[0] : ''
      // 上游返回泛型类型或缺省时，按文件扩展名兜底为正确音频 MIME，
      // 否则 <audio> 会因 octet-stream 而拒绝解码
      if (!contentType || contentType === 'application/octet-stream' || !contentType.startsWith('audio/')) {
        contentType = getAudioMime(filePath)
      }
      outHeaders['Content-Type'] = contentType
      if (resp.headers['content-length']) outHeaders['Content-Length'] = resp.headers['content-length']
      if (resp.headers['accept-ranges']) outHeaders['Accept-Ranges'] = resp.headers['accept-ranges']
      if (resp.headers['content-range']) outHeaders['Content-Range'] = resp.headers['content-range']
      outHeaders['Cache-Control'] = 'no-cache'
      res.writeHead(statusCode, outHeaders)

      // 边播边缓存：仅当请求从头开始（无 Range 或 bytes=0-）时写入，避免缓存部分分片
      const rangeHeader = String(req.headers.range || '')
      const isFullRange = !rangeHeader || rangeHeader === 'bytes=0-' || rangeHeader === 'bytes=0'
      if (isFullRange) {
        const tmpPath = cacheFilePath + '.tmp'
        const cacheWs = fs.createWriteStream(tmpPath, { flags: 'w' })
        let cacheReceived = 0
        const total = parseInt(resp.headers['content-length'] || '0', 10)
        options.trackProgress?.(total, 0)
        resp.on('data', (chunk: any) => {
          cacheReceived += chunk.length
          cacheWs.write(chunk)
          options.trackProgress?.(total, cacheReceived)
        })
        resp.on('end', () => {
          cacheWs.end(() => {
            // 下载完整则正式落盘，否则丢弃临时文件
            if (total === 0 || cacheReceived >= total) {
              fs.rename(tmpPath, cacheFilePath, (err: any) => {
                if (err) fs.unlink(tmpPath, () => { })
                options.markCacheDone?.()
              })
            } else {
              fs.unlink(tmpPath, () => { })
              options.clearCacheProgress?.()
            }
          })
        })
        resp.on('error', () => {
          cacheWs.destroy()
          fs.unlink(tmpPath, () => { })
          options.clearCacheProgress?.()
        })
        res.on('close', () => {
          // 客户端中断：停止缓存写入并清理临时文件（下次播放重新缓存）
          if (!resp.complete) {
            cacheWs.destroy()
            fs.unlink(tmpPath, () => { })
            options.clearCacheProgress?.()
          }
        })
      }
      resp.pipe(res)
    })
  }

  followRedirect(proxyReq)
  req.on('close', () => {
    if (!proxyReq.destroyed) proxyReq.destroy()
  })
}
