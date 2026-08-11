import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseTextPlaylist,
  parseLxJsonPlaylist,
  parsePlaylistContent,
  normalizeTitle,
} from './playlistParser'

describe('parseTextPlaylist 文本歌单解析', () => {
  test('解析歌手-歌名行', () => {
    const songs = parseTextPlaylist('周杰伦 - 七里香\nBeyond - 海阔天空')
    assert.strictEqual(songs.length, 2)
    assert.deepStrictEqual(songs[0], { singer: '周杰伦', name: '七里香' })
    assert.deepStrictEqual(songs[1], { singer: 'Beyond', name: '海阔天空' })
  })

  test('支持全角短横线分隔符', () => {
    const songs = parseTextPlaylist('许嵩–素颜')
    assert.strictEqual(songs.length, 1)
    assert.deepStrictEqual(songs[0], { singer: '许嵩', name: '素颜' })
  })

  test('无分隔符按整行歌名处理', () => {
    const songs = parseTextPlaylist('晴天\n')
    assert.strictEqual(songs.length, 1)
    assert.deepStrictEqual(songs[0], { singer: '', name: '晴天' })
  })

  test('忽略空行与注释行', () => {
    const songs = parseTextPlaylist('# 我的歌单\n\n周杰伦 - 晴天\n   \n')
    assert.strictEqual(songs.length, 1)
  })

  test('空内容返回空数组', () => {
    assert.deepStrictEqual(parseTextPlaylist(''), [])
    assert.deepStrictEqual(parseTextPlaylist('  \n\n'), [])
  })
})

describe('parseLxJsonPlaylist LX JSON 歌单解析', () => {
  const lxJson = JSON.stringify({
    name: '测试歌单',
    list: [
      { name: '七里香', singer: '周杰伦', source: 'wy', songmid: '185809', interval: '301' },
      { name: '晴天', singer: ['周杰伦'], source: 'tx', songmid: '001', albumName: '叶惠美' },
    ],
  })

  test('解析 list 数组', () => {
    const songs = parseLxJsonPlaylist(lxJson)
    assert.strictEqual(songs.length, 2)
    assert.strictEqual(songs[0].name, '七里香')
    assert.strictEqual(songs[0].singer, '周杰伦')
    assert.strictEqual(songs[0].source, 'wy')
    assert.strictEqual(songs[0].songmid, '185809')
    assert.strictEqual(songs[0].interval, '301')
  })

  test('singer 数组转为字符串', () => {
    const songs = parseLxJsonPlaylist(lxJson)
    assert.strictEqual(songs[1].singer, '周杰伦')
    assert.strictEqual(songs[1].albumName, '叶惠美')
  })

  test('非法 JSON 返回空数组', () => {
    assert.deepStrictEqual(parseLxJsonPlaylist('not-json'), [])
  })

  test('缺少 list 字段返回空数组', () => {
    assert.deepStrictEqual(parseLxJsonPlaylist('{"name":"x"}'), [])
  })

  test('跳过无 name 的项', () => {
    const songs = parseLxJsonPlaylist(JSON.stringify({ list: [{ singer: '周杰伦' }, { name: '晴天', singer: '周杰伦' }] }))
    assert.strictEqual(songs.length, 1)
    assert.strictEqual(songs[0].name, '晴天')
  })
})

describe('parsePlaylistContent 统一入口', () => {
  test('text 模式', async () => {
    const result = await parsePlaylistContent({ text: '周杰伦 - 七里香' })
    assert.strictEqual(result.source, 'text')
    assert.strictEqual(result.rawCount, 1)
    assert.strictEqual(result.songs.length, 1)
  })

  test('lxJson 模式优先于 text', async () => {
    const result = await parsePlaylistContent({
      lxJson: JSON.stringify({ list: [{ name: '晴天', singer: '周杰伦' }] }),
      text: '周杰伦 - 七里香',
    })
    assert.strictEqual(result.source, 'lx-json')
    assert.strictEqual(result.songs[0].name, '晴天')
  })

  test('空输入返回空结果', async () => {
    const result = await parsePlaylistContent({})
    assert.strictEqual(result.source, 'text')
    assert.strictEqual(result.songs.length, 0)
  })
})

describe('normalizeTitle 归一化', () => {
  test('去除空白与标点并转小写', () => {
    assert.strictEqual(normalizeTitle('Beyond- 海阔天空 '), 'beyond海阔天空')
    assert.strictEqual(normalizeTitle('周杰伦 / 费玉清'), '周杰伦费玉清')
  })

  test('空值返回空串', () => {
    assert.strictEqual(normalizeTitle(null), '')
    assert.strictEqual(normalizeTitle(undefined), '')
  })
})
