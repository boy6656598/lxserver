import * as path from 'node:path'
import * as fs from 'node:fs'
import { consumeCard } from './cards'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getUserDirname } = require('@/user')

const RENEW_PERIOD_MS = 30 * 24 * 60 * 60 * 1000
const RENEW_ACTIVE_SECONDS = 5 * 60
const MAX_TICK_MS = 60 * 1000
const FLUSH_DELAY = 5000
const SCAN_INTERVAL = 24 * 60 * 60 * 1000

const tickTimes = new Map<string, number>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

export interface AccessResult {
  ok: boolean
  reason: string
}

export interface RegisterResult {
  success: boolean
  code?: number
  message?: string
  username?: string
}

export interface AccountInfo {
  name: string
  password: string
  expireAt: number | null
  banned: boolean
  lastActiveAt: number
  activeSeconds: number
  periodStart: number
  telegramId: number | null
  dataPath: string
}

export const saveUsersFile = (): boolean => {
  const usersJsonPath = path.join(global.lx.dataPath, 'users.json')
  try {
    fs.writeFileSync(usersJsonPath, JSON.stringify(global.lx.config.users.map(u => ({
      name: u.name,
      password: u.password,
      maxSnapshotNum: u.maxSnapshotNum,
      'list.addMusicLocationType': u['list.addMusicLocationType'],
      expireAt: u.expireAt ?? null,
      banned: !!u.banned,
      lastActiveAt: u.lastActiveAt ?? 0,
      activeSeconds: u.activeSeconds ?? 0,
      periodStart: u.periodStart ?? 0,
      telegramId: u.telegramId ?? null,
    })), null, 2))
    return true
  } catch (err) {
    console.error('[UserAccount] Failed to save users.json:', err)
    return false
  }
}

const normalize = (u: LX.UserConfig): AccountInfo => {
  const now = Date.now()
  return {
    name: u.name,
    password: u.password,
    dataPath: u.dataPath,
    expireAt: u.expireAt === undefined ? null : u.expireAt,
    banned: !!u.banned,
    lastActiveAt: typeof u.lastActiveAt === 'number' && u.lastActiveAt > 0 ? u.lastActiveAt : now,
    activeSeconds: typeof u.activeSeconds === 'number' ? u.activeSeconds : 0,
    periodStart: typeof u.periodStart === 'number' && u.periodStart > 0 ? u.periodStart : now,
    telegramId: typeof u.telegramId === 'number' ? u.telegramId : null,
  }
}

const findUser = (name: string): LX.UserConfig | undefined =>
  global.lx.config.users.find(u => u.name === name)

/**
 * 获取归一化后的账号信息
 */
export const getUserAccount = (name: string): AccountInfo | null => {
  const u = findUser(name)
  return u ? normalize(u) : null
}

const scheduleFlush = (): void => {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    saveUsersFile()
  }, FLUSH_DELAY)
}

/**
 * 记录一次活跃行为：刷新 lastActiveAt 并节流累加当前周期活跃秒数
 */
export const recordActivity = (name: string): void => {
  const u = findUser(name)
  if (!u) return
  const now = Date.now()
  const acc = normalize(u)
  const lastTick = tickTimes.get(name) ?? now
  const diff = Math.min(Math.max(0, now - lastTick), MAX_TICK_MS)
  if (diff > 0) {
    acc.activeSeconds = (acc.activeSeconds ?? 0) + diff / 1000
    tickTimes.set(name, now)
  }
  acc.lastActiveAt = now
  Object.assign(u, acc)
  scheduleFlush()
}

/**
 * 到期时尝试活跃续期：30 天周期内累计活跃 ≥5 分钟则延长 30 天
 * @returns 续期处理后账号是否仍然有效
 */
const tryRenew = (u: LX.UserConfig): boolean => {
  const acc = normalize(u)
  if (acc.expireAt === null) return true
  const now = Date.now()
  if (now - acc.periodStart >= RENEW_PERIOD_MS) {
    if (acc.activeSeconds >= RENEW_ACTIVE_SECONDS) {
      acc.expireAt = acc.expireAt + RENEW_PERIOD_MS
    }
    acc.activeSeconds = 0
    acc.periodStart = now
  }
  Object.assign(u, acc)
  return acc.expireAt > now
}

/**
 * 统一入口校验：封禁 / 到期（含到期续期判定）
 */
export const checkUserAccess = (name: string): AccessResult => {
  const u = findUser(name)
  if (!u) return { ok: false, reason: '用户不存在' }
  const acc = normalize(u)
  Object.assign(u, acc)
  if (acc.banned) return { ok: false, reason: '账号已被封禁' }
  if (acc.expireAt !== null && Date.now() > acc.expireAt) {
    if (!tryRenew(u)) {
      saveUsersFile()
      return { ok: false, reason: '账号已到期' }
    }
    saveUsersFile()
  }
  return { ok: true, reason: 'ok' }
}

/**
 * 卡密注册：校验卡密并创建带账号生命周期的用户
 */
export const registerUserAccount = (
  username: unknown,
  password: unknown,
  cardCode: unknown,
  telegramId: number | null = null,
): RegisterResult => {
  if (!username || !password || !cardCode) {
    return { success: false, code: 400, message: '缺少用户名、密码或卡密' }
  }
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_\-]{2,32}$/.test(username)) {
    return { success: false, code: 400, message: '用户名仅支持字母/数字/下划线/短横线，长度2-32' }
  }
  if (typeof password !== 'string' || password.length < 6) {
    return { success: false, code: 400, message: '密码长度至少6位' }
  }
  if (global.lx.config.users.some(u => u.name === username)) {
    return { success: false, code: 409, message: '用户名已存在' }
  }
  if (global.lx.config['player.enableRegister'] === false) {
    return { success: false, code: 403, message: '注册功能已关闭' }
  }
  let expireDays: number | null
  try {
    expireDays = consumeCard(String(cardCode), username as string).expireDays
  } catch (err: any) {
    return { success: false, code: 400, message: err?.message || '卡密校验失败' }
  }
  const now = Date.now()
  const dataPath = path.join(global.lx.userPath, getUserDirname(username as string))
  try {
    fs.mkdirSync(dataPath, { recursive: true })
  } catch (err: any) {
    return { success: false, code: 500, message: `创建用户目录失败: ${err?.message || ''}` }
  }
  global.lx.config.users.push({
    name: username as string,
    password: password as string,
    dataPath,
    expireAt: expireDays && expireDays > 0 ? now + expireDays * 24 * 60 * 60 * 1000 : null,
    banned: false,
    lastActiveAt: now,
    activeSeconds: 0,
    periodStart: now,
    telegramId,
  })
  saveUsersFile()
  try {
    // 通知管理群（惰性 require 避免循环依赖）
    const telegramBot = require('./telegramBot')
    telegramBot.notify(`新用户注册：<b>${escapeHtml(String(username))}</b>\n有效期：${expireDays && expireDays > 0 ? expireDays + ' 天' : '永久'}`)
  } catch (err) { }
  return { success: true, username: username as string }
}

const escapeHtml = (value: unknown): string => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')

/**
 * 将 TG 用户 ID 绑定到已有账号（校验密码）
 */
export const bindTelegram = (
  username: unknown,
  password: unknown,
  telegramId: number,
): { success: boolean; message?: string } => {
  const u = findUser(String(username || ''))
  if (!u) return { success: false, message: '用户不存在' }
  if (u.password !== String(password || '')) return { success: false, message: '密码错误' }
  const acc = normalize(u)
  acc.telegramId = telegramId
  Object.assign(u, acc)
  saveUsersFile()
  return { success: true }
}

/**
 * 通过 TG 用户 ID 查找绑定的用户名
 */
export const findUserByTelegramId = (telegramId: number): string | null => {
  const u = global.lx.config.users.find(u => u.telegramId === telegramId)
  return u ? u.name : null
}

/**
 * 管理后台：设置账号到期时间（null 为永久）
 */
export const setExpire = (name: string, expireAt: number | null): { success: boolean; message?: string } => {
  const u = findUser(name)
  if (!u) return { success: false, message: '用户不存在' }
  const acc = normalize(u)
  acc.expireAt = expireAt
  Object.assign(u, acc)
  saveUsersFile()
  return { success: true }
}

/**
 * 管理后台：手动续期（延长 N 天），永久账号跳过
 */
export const renewExpire = (name: string, days: number): { success: boolean; message?: string } => {
  const u = findUser(name)
  if (!u) return { success: false, message: '用户不存在' }
  const acc = normalize(u)
  if (acc.expireAt !== null) {
    acc.expireAt = acc.expireAt + days * 24 * 60 * 60 * 1000
  }
  Object.assign(u, acc)
  saveUsersFile()
  return { success: true }
}

/**
 * 管理后台：封禁/解封
 */
export const setBanned = (name: string, banned: boolean): { success: boolean; message?: string } => {
  const u = findUser(name)
  if (!u) return { success: false, message: '用户不存在' }
  const acc = normalize(u)
  acc.banned = banned
  if (!banned) acc.lastActiveAt = Date.now()
  Object.assign(u, acc)
  saveUsersFile()
  return { success: true }
}

/**
 * 管理后台：修改密码
 */
export const changePassword = (
  name: string,
  oldPassword: string,
  newPassword: string,
): { success: boolean; message?: string } => {
  const u = findUser(name)
  if (!u) return { success: false, message: '用户不存在' }
  if (u.password !== oldPassword) return { success: false, message: '旧密码错误' }
  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    return { success: false, message: '新密码长度至少6位' }
  }
  u.password = newPassword
  saveUsersFile()
  return { success: true }
}

/**
 * 管理后台：返回含账号生命周期字段的用户列表
 */
export const listAccounts = (): AccountInfo[] => {
  return global.lx.config.users.map(u => normalize(u))
}

/**
 * 每日扫描：活跃续期 + 无活跃自动封禁
 */
const runPeriodicScan = (): void => {
  const banDays = Number(global.lx.config['user.autoBanInactiveDays']) || 0
  const now = Date.now()
  let changed = false
  for (const u of global.lx.config.users) {
    const acc = normalize(u)
    Object.assign(u, acc)
    if (acc.expireAt !== null && now - acc.periodStart >= RENEW_PERIOD_MS) {
      if (acc.activeSeconds >= RENEW_ACTIVE_SECONDS) {
        acc.expireAt = acc.expireAt + RENEW_PERIOD_MS
      }
      acc.activeSeconds = 0
      acc.periodStart = now
      changed = true
    }
    if (
      banDays > 0 &&
      acc.expireAt !== null &&
      !acc.banned &&
      acc.lastActiveAt > 0 &&
      now - acc.lastActiveAt > banDays * 24 * 60 * 60 * 1000
    ) {
      acc.banned = true
      changed = true
      try {
        const telegramBot = require('./telegramBot')
        telegramBot.notify(`账号 <b>${escapeHtml(u.name)}</b> 因超过 ${banDays} 天无活跃已被自动封禁。`)
      } catch (err) { }
    }
    Object.assign(u, acc)
  }
  if (changed) saveUsersFile()
}

/**
 * 初始化：归一化历史用户并启动每日扫描定时任务
 */
export const initAccountManager = (): void => {
  let changed = false
  for (const u of global.lx.config.users) {
    const before = JSON.stringify(u)
    Object.assign(u, normalize(u))
    if (JSON.stringify(u) !== before) changed = true
  }
  if (changed) saveUsersFile()
  setInterval(() => {
    runPeriodicScan()
  }, SCAN_INTERVAL)
  runPeriodicScan()
}
