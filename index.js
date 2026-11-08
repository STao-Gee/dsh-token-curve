// dsh-token-curve · 宿主半边
//
// 三件事：
//   1. 这个会话每一轮的 token 与费用（曲线页）；
//   2. 本机全部会话的账本：按月 / 按周汇总 + 逐轮明细 + 导出 Excel（账单页）；
//   3. 账户余额：直接问 DSH 自己的账号服务（deepseekAccount.getBalance），
//      跟「设置 → 账户」页上的钱包是同一个来源，不另存密钥、不碰登录态。
//
// 为什么在宿主算，而不是在浏览器里读聊天视图：聊天 UI 的「每轮用量」受
// 设置 → 性能与用量（ui-chat.performanceUsage）控制，简洁模式压根不生成每轮数字；
// 而会话日志永远完整。日志里每条 assistant/message 的 data.usage 就是提供方
// 上报的账单（input / cacheRead / cacheWrite / output / total），按轮把消息相加，
// 得到的就是「这一轮实际花了多少」，不做任何估算。
//
// 费用按官方价目 × 每条消息自己的时间戳判峰谷，逐条计价再相加 ——
// 不是拿整轮的平均价，跨峰谷的一轮也不会算错。
//
// 只读：不写、不改、不删任何会话文件。
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync, deflateRawSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const VERSION = '0.4.1'

// 启动自检：apply 到底跑没跑、connection 注入到底来没来。
// 这行日志是排查「路由 404」唯一的现场证据；成功请求不写，免得日志每 4 秒长一行。
function trace(message) {
  // 验证脚本会在独立进程里 import 这个文件；别让它们的假数据写进真机日志。
  if (process.env.DSH_TOKEN_CURVE_NO_LOG === '1') return
  try {
    appendFileSync(join(HERE, 'host.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // 写不了就算了，不能因为日志挂掉插件
  }
}

export const name = 'dsh-token-curve'

export const inject = []

const ROUTE = '/api/token-curve'
const EXPORT_ROUTE = '/api/token-curve-export'
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const STORE_NAMES = ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl.zstd', 'session.jsonl']

// ---------- 价目 ----------
// 内置表只是「兜底」：来源 DeepSeek 官方《模型 & 价格》，2026-11-08 抓取。
// 单位：人民币元 / 百万 tokens。
// 峰时：北京时间周一至周五（不含法定节假日）9:00–12:00、14:00–18:00；
// 其余（含周末、法定节假日全天）为空闲，空闲价 = 高峰价的一半。
//
// 官方一调价，内置表就是旧账。所以每次打开面板会按需去官方页同步（12 小时一次）：
// 解析成功就换上新表，解析失败/没网就继续用内置表，并把状态写进响应给面板显示。
const PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'
const PRICING_TTL_MS = 12 * 3600 * 1000
const PRICING_RETRY_MS = 60 * 60 * 1000

const BUILTIN_PRICING = {
  source: PRICING_URL,
  fetchedAt: '2026-11-08',
  currency: 'CNY',
  unit: '元 / 百万 tokens',
  note: '空闲价 = 高峰价的一半；已扣除法定节假日（2025–2027）。',
  models: [
    {
      id: 'deepseek-flash',
      match: /^deepseek-(?:v4(?:\.\d+)?-)?flash/i,
      hit: { peak: 0.04, off: 0.02 },
      miss: { peak: 2, off: 1 },
      out: { peak: 8, off: 4 },
    },
    {
      id: 'deepseek-v4-pro',
      match: /^deepseek-(?:v4-)?pro/i,
      hit: { peak: 0.3, off: 0.15 },
      miss: { peak: 9, off: 4.5 },
      out: { peak: 27, off: 13.5 },
    },
  ],
}

// 当前生效的价目。syncedAt=0 表示还没同步过，mode 告诉面板这张表是哪来的。
let pricingState = {
  table: BUILTIN_PRICING,
  mode: 'builtin',
  fetchedAt: BUILTIN_PRICING.fetchedAt,
  syncedAt: 0,
  nextTry: 0,
  error: '',
}

/**
 * 从官方页文本里抠出六个价、两个模型，并按「先 flash 后 pro」的列序落位。
 * 任何一步对不上就抛错 —— 宁可继续用内置表，也不要把别人的价安到错的模型上。
 * @param text - flattened page text (tags stripped).
 * @returns {{fetchedAt: string, models: Array}} parsed table.
 */
function parsePricing(text) {
  const flat = String(text)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;|&amp;/g, ' ')
    .replace(/\s+/g, ' ')

  const flashAt = flat.indexOf('deepseek-flash')
  const proAt = flat.indexOf('deepseek-v4-pro')
  if (flashAt < 0 || proAt < 0) throw new Error('页面里找不到 deepseek-flash / deepseek-v4-pro')
  if (proAt < flashAt) throw new Error('模型列序变了（pro 跑到 flash 前面）')

  const row = (label) => {
    const pattern = new RegExp(
      `${label}[^0-9]{0,40}?空闲时段\\s*([\\d.]+)\\s*元\\s*([\\d.]+)\\s*元\\s*高峰时段\\s*([\\d.]+)\\s*元\\s*([\\d.]+)\\s*元`,
    )
    const match = pattern.exec(flat)
    if (match === null) throw new Error(`价目行没匹配上：${label}`)
    const [flashOff, proOff, flashPeak, proPeak] = match.slice(1).map(Number)
    return { flash: { off: flashOff, peak: flashPeak }, pro: { off: proOff, peak: proPeak } }
  }

  const hit = row('缓存命中')
  const miss = row('缓存未命中')
  const out = row('百万tokens输出')

  const models = BUILTIN_PRICING.models.map((entry) => {
    const key = entry.id === 'deepseek-flash' ? 'flash' : 'pro'
    const table = { id: entry.id, match: entry.match, hit: hit[key], miss: miss[key], out: out[key] }
    for (const bucket of ['hit', 'miss', 'out']) {
      const rates = table[bucket]
      if (!(rates.off > 0) || !(rates.peak > 0)) throw new Error(`${entry.id} 的 ${bucket} 价不是正数`)
      if (rates.peak < rates.off) throw new Error(`${entry.id} 的 ${bucket} 高峰价低于空闲价`)
      if (table.miss.off < table.hit.off) throw new Error(`${entry.id} 的未命中价低于命中价`)
      if (table.out.off < table.hit.off) throw new Error(`${entry.id} 的输出价低于命中价`)
    }
    return table
  })

  return { fetchedAt: new Date().toISOString().slice(0, 10), models }
}

/**
 * 按需同步官方价目：缓存 12 小时，失败 1 小时后重试。
 * 失败只记录原因、保留旧表，不抛给调用方 —— 面板永远有价可用。
 * @param force - bypass the cache (the panel's 立刻同步 button).
 * @returns the pricing state in effect.
 */
async function ensurePricing(force = false) {
  const now = Date.now()
  if (!force) {
    if (pricingState.syncedAt > 0 && now - pricingState.syncedAt < PRICING_TTL_MS) return pricingState
    if (now < pricingState.nextTry) return pricingState
  }
  try {
    const response = await fetch(PRICING_URL, {
      headers: { 'user-agent': 'dsh-token-curve/0.4 (+pricing sync)' },
      signal: AbortSignal.timeout(9000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = await response.text()
    const parsed = parsePricing(text)
    pricingState = {
      table: { ...BUILTIN_PRICING, ...parsed },
      mode: 'synced',
      fetchedAt: parsed.fetchedAt,
      syncedAt: now,
      nextTry: 0,
      error: '',
    }
    trace(`pricing synced (${parsed.fetchedAt}): flash hit ${parsed.models[0].hit.off}/${parsed.models[0].hit.peak}`)
  } catch (error) {
    pricingState = {
      ...pricingState,
      syncedAt: 0,
      nextTry: now + PRICING_RETRY_MS,
      error: String(error?.message ?? error),
    }
    trace(`pricing sync failed: ${pricingState.error}`)
  }
  return pricingState
}

/** 按模型名找价目；找不到返回 undefined，调用方据此把费用标成「未收录」。 */
function priceTableOf(model) {
  if (typeof model !== 'string' || model === '') return undefined
  return pricingState.table.models.find((entry) => entry.match.test(model))
}

// ---------- 节假日 ----------
// 官方高峰时段是「周一至周五，不含中国法定节假日」。所以只要知道哪些日子是法定假日，
// 把工作日里的假日剔掉即可；调休上班的周六周日仍按「周末」算空闲（官方口径就是按周末）。
//
// 数据：国务院办公厅 2026 年通知（国办发明电〔2025〕7号，2025-11-04）
//   https://www.gov.cn/zhengce/content/202511/content_7047090.htm
// 2025 / 2027 同源于国务院办公厅当年通知（经 holiday-cn 数据集转录，已逐条核对 2026 原文一致）。
// 只收「放假」的日子（isOffDay=true），调休上班日不收。
const HOLIDAYS_SOURCE = 'https://www.gov.cn/zhengce/content/202511/content_7047090.htm'
const HOLIDAYS = {
  2025: '01-01 01-28 01-29 01-30 01-31 02-01 02-02 02-03 02-04 04-04 04-05 04-06 05-01 05-02 05-03 05-04 05-05 05-31 06-01 06-02 10-01 10-02 10-03 10-04 10-05 10-06 10-07 10-08',
  2026: '01-01 01-02 01-03 02-15 02-16 02-17 02-18 02-19 02-20 02-21 02-22 02-23 04-04 04-05 04-06 05-01 05-02 05-03 05-04 05-05 06-19 06-20 06-21 09-25 09-26 09-27 10-01 10-02 10-03 10-04 10-05 10-06 10-07',
  2027: '01-01 01-02 01-03 02-05 02-06 02-07 02-08 02-09 02-10 02-11 02-12 02-13 04-03 04-04 04-05 05-01 05-02 05-03 05-04 05-05 06-09 09-15 10-01 10-02 10-03 10-04 10-05 10-06 10-07',
}
const holidaySets = new Map(
  Object.entries(HOLIDAYS).map(([year, list]) => [Number(year), new Set(list.split(' '))]),
)
const holidayYears = [...holidaySets.keys()].sort((left, right) => left - right)
const pad2 = (value) => String(value).padStart(2, '0')

/** 这个 epoch 毫秒在北京时间是哪一天、星期几。 */
function beijingDay(at) {
  const shifted = new Date(at + 8 * 3600 * 1000)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    date: shifted.getUTCDate(),
    monthDay: `${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`,
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours() + shifted.getUTCMinutes() / 60,
  }
}

/** 北京某一天 0 点的 epoch 毫秒。month 允许越界（13 = 下一年 1 月）。 */
function beijingMidnight(year, month, date) {
  return Date.UTC(year, month - 1, date) - 8 * 3600 * 1000
}

/** 这一天是不是法定假日（放假）。没收录的年份按「不是假日」处理，并会被标成未覆盖。 */
function isHoliday(year, monthDay) {
  const set = holidaySets.get(year)
  return set === undefined ? false : set.has(monthDay)
}

/**
 * 一条消息落在高峰还是空闲。
 * 北京时间固定 UTC+8、无夏令时，所以直接平移再读 UTC 字段，不依赖运行环境的时区。
 * @param at - epoch milliseconds.
 * @returns true only for a weekday 9–12 / 14–18 that is not a statutory holiday.
 */
function isPeak(at) {
  if (!(at > 0)) return false
  const day = beijingDay(at)
  if (day.weekday === 0 || day.weekday === 6) return false
  if (isHoliday(day.year, day.monthDay)) return false
  return (day.hour >= 9 && day.hour < 12) || (day.hour >= 14 && day.hour < 18)
}

/** 一份用量在给定时刻的价钱（元）。没有价目表就返回 undefined。 */
function priceOf(usage, table, at) {
  if (table === undefined) return undefined
  const peak = isPeak(at)
  const hit = peak ? table.hit.peak : table.hit.off
  const miss = peak ? table.miss.peak : table.miss.off
  const out = peak ? table.out.peak : table.out.off
  // 缓存写入在官方价目里没有单列：按「未命中输入」计价（宁可高估，不漏算）。
  const cny = (usage.input * miss + usage.cacheRead * hit + usage.cacheWrite * miss + usage.output * out) / 1e6
  return { cny, peak }
}

// ---------- 会话文件 ----------

function sessionsRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'sessions')
}

function findSessionFile(sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!/^session-[A-Za-z0-9-]+$/.test(id)) return null
  const root = sessionsRoot()
  let buckets = []
  try {
    buckets = readdirSync(root)
  } catch {
    return null
  }
  for (const bucket of buckets) {
    const dir = join(root, bucket, id)
    if (!existsSync(dir)) continue
    for (const name of STORE_NAMES) {
      const file = join(dir, name)
      if (existsSync(file)) return file
    }
  }
  return null
}

/** 本机全部会话文件（含子会话、分组会话）。只列路径，不读内容。 */
function listSessionFiles() {
  const root = sessionsRoot()
  const out = []
  let buckets = []
  try {
    buckets = readdirSync(root)
  } catch {
    return out
  }
  for (const bucket of buckets) {
    const bucketDir = join(root, bucket)
    let dirs = []
    try {
      dirs = readdirSync(bucketDir)
    } catch {
      continue
    }
    for (const dir of dirs) {
      for (const name of STORE_NAMES) {
        const file = join(bucketDir, dir, name)
        if (existsSync(file)) {
          out.push({ file, sessionId: dir, bucket })
          break
        }
      }
    }
  }
  return out
}

// DSH 的会话文件是「每行一帧」的多帧 zstd。Node 的 zstdDecompressSync 一次只解
// 首帧，所以按帧魔数切开逐帧解 —— 解不动的那一帧跳过，不让一行坏数据废掉整份。
function readEvents(file) {
  const buffer = readFileSync(file)
  if (!file.endsWith('.zstd')) return parseLines(buffer.toString('utf8'))
  const starts = []
  let cursor = 0
  while ((cursor = buffer.indexOf(ZSTD_MAGIC, cursor)) !== -1) {
    starts.push(cursor)
    cursor += 4
  }
  if (starts.length === 0) return parseLines(buffer.toString('utf8'))
  const parts = []
  for (let index = 0; index < starts.length; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(starts[index], end)))
    } catch {
      // 坏帧跳过
    }
  }
  return parseLines(Buffer.concat(parts).toString('utf8'))
}

function parseLines(text) {
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      // 半行（正好在写入）或损坏行，跳过
    }
  }
  return events
}

/**
 * 只留「这个会话自己」的事件。
 *
 * 从别的会话分叉出来的会话（日志头 isSeeded=true + parentSession）会把父会话的历史
 * 事件整段抄进自己的日志。那部分 token 是父会话付过的，再算一遍就是重复收费。
 * 分叉会话的 createdAt 就是分叉时刻，之前的事件都是抄来的 —— 按它切掉。
 * @returns {{events: Array, inheritedMessages: number}} own events + how many were dropped.
 */
function ownEvents(events) {
  const header = events.find((event) => event && event.type === 'session') ?? null
  const createdAt = typeof header?.createdAt === 'number' ? header.createdAt : 0
  if (header?.isSeeded !== true || !(createdAt > 0)) return { events, inheritedMessages: 0 }
  let dropped = 0
  const kept = []
  for (const event of events) {
    if (typeof event?.time === 'number' && event.time < createdAt) {
      if (event.type === 'assistant/message') dropped += 1
      continue
    }
    kept.push(event)
  }
  return { events: kept, inheritedMessages: dropped }
}

// ---------- 折叠 ----------

const count = (value) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined)

/** 金额统一保留 4 位小数（分以下两位），明细可核对，汇总再按 2 位显示。 */
const money4 = (value) => Math.round((Number.isFinite(value) ? value : 0) * 1e4) / 1e4

/** 一条消息的用量；字段缺失或不是安全整数就当作这条没报，不猜。 */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const input = count(usage.inputTokens)
  const output = count(usage.outputTokens)
  const cacheRead = count(usage.cacheReadTokens)
  const cacheWrite = count(usage.cacheWriteTokens)
  const total = count(usage.totalTokens)
  if (input === undefined || output === undefined) return null
  return {
    input,
    output,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    total: total ?? input + output + (cacheRead ?? 0) + (cacheWrite ?? 0),
  }
}

/**
 * 按轮聚合。每一轮的用量 = 该轮内所有已提交 assistant 消息的用量之和，
 * 费用 = 每条消息按自己的时间戳判峰谷、各自计价后相加。
 * 只有提交成消息的那次尝试才产生计费（失败/被丢弃的尝试只留 assistant/attempt，
 * 没有 message），所以这里天然跳过了重试里没落地的部分。
 * @param events - the session's durable events, in log order.
 * @returns per-turn usage and cost plus whole-session totals.
 */
export function foldTurns(events) {
  const turns = []
  let current = null
  let model = ''
  let provider = ''
  let ignoredMessages = 0
  let pricedMessages = 0
  let unpricedMessages = 0

  const ensure = (turn, time) => {
    if (current !== null && current.turn === turn) return current
    const existing = turns.find((item) => item.turn === turn)
    if (existing !== undefined) return existing
    const record = {
      turn,
      startTime: time ?? 0,
      endTime: 0,
      open: true,
      messages: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      total: 0,
      cny: 0,
      pricedMessages: 0,
      unpricedMessages: 0,
      peakMessages: 0,
      offPeakMessages: 0,
      models: [],
      unknownUsage: 0,
    }
    turns.push(record)
    return record
  }

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const data = event.data && typeof event.data === 'object' ? event.data : {}
    if (event.type === 'turn/start') {
      if (typeof data.turn !== 'number') continue
      const record = ensure(data.turn, event.time)
      record.startTime = event.time ?? record.startTime
      record.open = true
      current = record
      continue
    }
    if (event.type === 'turn/end') {
      if (typeof data.turn === 'number') {
        const record = turns.find((item) => item.turn === data.turn)
        if (record !== undefined) {
          record.open = false
          record.endTime = event.time ?? record.endTime
        }
      }
      if (current !== null && current.turn === data.turn) current = null
      continue
    }
    if (event.type !== 'assistant/message') continue
    const turn = current ?? (typeof data.turn === 'number' ? ensure(data.turn, event.time) : null)
    if (turn === null) {
      ignoredMessages += 1
      continue
    }
    const usage = normalizeUsage(data.usage)
    if (usage === null) {
      turn.unknownUsage += 1
      continue
    }
    turn.messages += 1
    turn.input += usage.input
    turn.cacheRead += usage.cacheRead
    turn.cacheWrite += usage.cacheWrite
    turn.output += usage.output
    turn.total += usage.total

    const source = data.message && typeof data.message === 'object' ? data.message.source : undefined
    if (source && typeof source === 'object') {
      if (typeof source.provider === 'string' && source.provider !== '') provider = source.provider
      if (typeof source.model === 'string' && source.model !== '') {
        model = source.model
        if (!turn.models.includes(source.model)) turn.models.push(source.model)
      }
    }

    const priced = priceOf(usage, priceTableOf(model), typeof event.time === 'number' ? event.time : 0)
    if (priced === undefined) {
      turn.unpricedMessages += 1
      unpricedMessages += 1
    } else {
      turn.cny += priced.cny
      turn.pricedMessages += 1
      pricedMessages += 1
      if (priced.peak) turn.peakMessages += 1
      else turn.offPeakMessages += 1
    }

    if (typeof event.time === 'number') turn.endTime = event.time
  }

  turns.sort((left, right) => left.turn - right.turn)

  const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, cny: 0, pricedMessages: 0 }
  let unknownUsage = 0
  for (const turn of turns) {
    totals.input += turn.input
    totals.cacheRead += turn.cacheRead
    totals.cacheWrite += turn.cacheWrite
    totals.output += turn.output
    totals.total += turn.total
    totals.cny += turn.cny
    totals.pricedMessages += turn.pricedMessages
    unknownUsage += turn.unknownUsage
  }

  return { turns, totals, model, provider, ignoredMessages, unknownUsage, pricedMessages, unpricedMessages }
}

// 同一个文件没变就不重复解压：面板 4 秒问一次，不能每次都把几 MB 解一遍。
const cache = new Map()

function turnsOf(sessionId) {
  const file = findSessionFile(sessionId)
  if (file === null) return { ok: false, error: '找不到这个会话的日志文件' }
  let stat
  try {
    stat = statSync(file)
  } catch (error) {
    return { ok: false, error: `读不到日志文件：${error?.message ?? error}` }
  }
  // 价目换了，缓存里的金额就作废：把价目版本并进缓存键。
  const key = `${stat.size}:${stat.mtimeMs}:${pricingState.fetchedAt}`
  const cached = cache.get(file)
  if (cached !== undefined && cached.key === key) return { ok: true, value: cached.value }

  let events
  try {
    events = readEvents(file)
  } catch (error) {
    return { ok: false, error: `解不开日志文件：${error?.message ?? error}` }
  }
  const own = ownEvents(events)
  events = own.events

  const folded = foldTurns(events)
  const table = priceTableOf(folded.model)
  const value = {
    sessionId,
    at: Date.now(),
    eventCount: events.length,
    inheritedMessages: own.inheritedMessages,
    turnCount: folded.turns.length,
    model: folded.model,
    provider: folded.provider,
    totals: folded.totals,
    turns: folded.turns,
    ignoredMessages: folded.ignoredMessages,
    unknownUsage: folded.unknownUsage,
    pricedMessages: folded.pricedMessages,
    unpricedMessages: folded.unpricedMessages,
    holidays: {
      source: HOLIDAYS_SOURCE,
      years: holidayYears,
    },
    pricing: {
      source: BUILTIN_PRICING.source,
      fetchedAt: pricingState.fetchedAt,
      mode: pricingState.mode,
      syncedAt: pricingState.syncedAt,
      syncError: pricingState.error,
      currency: BUILTIN_PRICING.currency,
      unit: BUILTIN_PRICING.unit,
      note: BUILTIN_PRICING.note,
      matched: table === undefined ? null : table.id,
      rates: table === undefined ? null : { hit: table.hit, miss: table.miss, out: table.out },
    },
  }
  cache.set(file, { key, value })
  return { ok: true, value }
}

// ---------- 账本：跨会话按月 / 按周 ----------

/** 从一条 message 的 content 里取纯文字（标题兜底用）。 */
function messageText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

// 一个会话只解一次：文件大小 + 修改时间 + 价目版本 做缓存键。
const sessionCache = new Map()

/**
 * 读一个会话文件，压成「会话 + 逐轮」的紧凑记录。只保留汇总需要的字段，
 * 不把整份事件留在内存里（49 个会话 ≈ 52MB 压缩日志）。
 */
function snapshotSession(file) {
  let stat
  try {
    stat = statSync(file)
  } catch {
    return null
  }
  const key = `${stat.size}:${stat.mtimeMs}:${pricingState.fetchedAt}`
  const cached = sessionCache.get(file)
  if (cached !== undefined && cached.key === key) return cached.value

  let events
  try {
    events = readEvents(file)
  } catch {
    return null
  }
  const own = ownEvents(events)
  events = own.events

  const header = events.find((event) => event && event.type === 'session') ?? {}
  const folded = foldTurns(events)

  let title = ''
  for (const event of events) {
    if (event?.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title.trim() !== '') {
      title = event.data.title.trim()
    }
  }
  if (title === '') {
    for (const event of events) {
      if (event?.type !== 'user/message') continue
      if (event.data?.source?.kind !== 'user') continue
      const text = messageText(event.data?.content)
      if (text !== '') {
        title = text.slice(0, 24)
        break
      }
    }
  }

  const createdAt = typeof header.createdAt === 'number' ? header.createdAt : (events[0]?.time ?? 0)
  const cwd = typeof header.cwd === 'string' ? header.cwd : ''
  const sessionId = typeof header.id === 'string' ? header.id : basename(dirname(file))
  const depth = typeof header.delegationDepth === 'number' ? header.delegationDepth : 0

  const turns = folded.turns
    .filter((turn) => turn.messages > 0)
    .map((turn) => ({
      turn: turn.turn,
      time: turn.startTime || turn.endTime || createdAt,
      endTime: turn.endTime,
      open: turn.open,
      messages: turn.messages,
      input: turn.input,
      cacheRead: turn.cacheRead,
      cacheWrite: turn.cacheWrite,
      output: turn.output,
      total: turn.total,
      cny: turn.cny,
      priced: turn.pricedMessages,
      unpriced: turn.unpricedMessages,
      peak: turn.peakMessages,
      off: turn.offPeakMessages,
      model: turn.models.length > 0 ? turn.models[turn.models.length - 1] : folded.model,
    }))

  const value = {
    file,
    sessionId,
    cwd,
    workspace: cwd === '' ? '未知工作区' : basename(cwd) || cwd,
    title: title === '' ? `会话 ${sessionId.slice(-6)}` : title,
    depth,
    createdAt,
    model: folded.model,
    inheritedMessages: own.inheritedMessages,
    turns,
    totals: folded.totals,
  }
  sessionCache.set(file, { key, value })
  return value
}

const RANGE_KINDS = ['all', 'this-month', 'last-month', 'last-3m', 'this-year']

/** 把「本月 / 上月 / 近三个月 / 今年 / 全部」翻成北京时间的一个左闭右开区间。 */
function resolveRange(kind) {
  const now = Date.now()
  const today = beijingDay(now)
  const monthStart = (offset) => {
    const total = today.year * 12 + (today.month - 1) + offset
    const year = Math.floor(total / 12)
    const month = (total % 12) + 1
    return beijingMidnight(year, month, 1)
  }
  switch (kind) {
    case 'this-month':
      return { kind, from: monthStart(0), to: now, label: `${today.year}年${today.month}月` }
    case 'last-month': {
      const from = monthStart(-1)
      const taken = beijingDay(from)
      return { kind, from, to: monthStart(0), label: `${taken.year}年${taken.month}月` }
    }
    case 'last-3m':
      return { kind, from: monthStart(-2), to: now, label: '近三个月' }
    case 'this-year':
      return { kind, from: beijingMidnight(today.year, 1, 1), to: now, label: `${today.year}年` }
    default:
      return { kind: 'all', from: 0, to: now + 60 * 1000, label: '全部' }
  }
}

/** 一个时刻落在哪个汇总格：月（YYYY-MM）或周（周一为一周之始）。 */
function periodOf(at, groupBy) {
  const day = beijingDay(at)
  if (groupBy === 'week') {
    const dayStart = beijingMidnight(day.year, day.month, day.date)
    const offset = (day.weekday + 6) % 7
    const monday = dayStart - offset * 86400000
    const first = beijingDay(monday)
    return {
      key: `${first.year}-${pad2(first.month)}-${pad2(first.date)}`,
      from: monday,
      to: monday + 7 * 86400000,
      year: first.year,
      month: first.month,
      date: first.date,
    }
  }
  return {
    key: `${day.year}-${pad2(day.month)}`,
    from: beijingMidnight(day.year, day.month, 1),
    to: beijingMidnight(day.year, day.month + 1, 1),
    year: day.year,
    month: day.month,
    date: 1,
  }
}

function periodLabel(period, groupBy) {
  if (groupBy !== 'week') return `${period.year}年${period.month}月`
  const end = new Date(period.from + 6 * 86400000 + 8 * 3600 * 1000)
  const sameMonth = end.getUTCMonth() + 1 === period.month
  const tail = sameMonth ? `${pad2(end.getUTCDate())}` : `${pad2(end.getUTCMonth() + 1)}/${pad2(end.getUTCDate())}`
  return `${pad2(period.month)}/${pad2(period.date)}–${tail}`
}

/** 日期时间（北京时间），导出和明细都用它。 */
function beijingStamp(at, withSeconds = false) {
  const day = beijingDay(at)
  const shifted = new Date(at + 8 * 3600 * 1000)
  const date = `${day.year}-${pad2(day.month)}-${pad2(day.date)}`
  const time = `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}${withSeconds ? `:${pad2(shifted.getUTCSeconds())}` : ''}`
  return { date, time, stamp: `${date} ${time}` }
}

const emptyTotals = () => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  total: 0,
  cny: 0,
  turns: 0,
  messages: 0,
  priced: 0,
  unpriced: 0,
})

function addTurn(target, turn) {
  target.input += turn.input
  target.cacheRead += turn.cacheRead
  target.cacheWrite += turn.cacheWrite
  target.output += turn.output
  target.total += turn.total
  // 金额先按「分以下 4 位」落定再相加：这样汇总列、明细列、合计行用的是同一批数字，
  // 老板在 Excel 里把金额列一拉，和合计行对得上（原值相加再四舍五入会对不上几分钱）。
  target.cny += money4(turn.cny)
  target.turns += 1
  target.messages += turn.messages
  target.priced += turn.priced
  target.unpriced += turn.unpriced
}

const DETAIL_LIMIT = 4000

/**
 * 扫全部会话，按区间与口径汇总。
 * @param args - { groupBy: 'month'|'week', range: 'all'|'this-month'|..., full?: boolean }
 * @returns periods（新→旧）、details（新→旧）、sessions、totals 与口径信息。
 */
function collectLedger(args = {}) {
  const started = Date.now()
  const groupBy = args.groupBy === 'week' ? 'week' : 'month'
  const range = resolveRange(RANGE_KINDS.includes(args.range) ? args.range : 'all')
  const files = listSessionFiles()

  const periods = new Map()
  const periodSessions = new Map()
  const details = []
  const sessionRows = []
  const totals = emptyTotals()
  let scanned = 0
  let skipped = 0
  let inherited = 0
  let oldest = 0
  let newest = 0

  for (const entry of files) {
    const session = snapshotSession(entry.file)
    if (session === null) {
      skipped += 1
      continue
    }
    scanned += 1
    inherited += session.inheritedMessages
    const sessionTotals = emptyTotals()
    let used = 0
    for (const turn of session.turns) {
      const at = turn.time > 0 ? turn.time : session.createdAt
      if (!(at >= range.from) || !(at < range.to)) continue
      used += 1
      const period = periodOf(at, groupBy)
      let bucket = periods.get(period.key)
      if (bucket === undefined) {
        bucket = { key: period.key, from: period.from, to: period.to, label: periodLabel(period, groupBy), ...emptyTotals(), sessions: 0 }
        periods.set(period.key, bucket)
        periodSessions.set(period.key, new Set())
      }
      addTurn(bucket, turn)
      addTurn(totals, turn)
      addTurn(sessionTotals, turn)
      periodSessions.get(period.key).add(session.sessionId)
      if (oldest === 0 || at < oldest) oldest = at
      if (at > newest) newest = at
      details.push({
        time: at,
        period: period.key,
        sessionId: session.sessionId,
        title: session.title,
        workspace: session.workspace,
        depth: session.depth,
        turn: turn.turn,
        model: turn.model,
        input: turn.input,
        cacheRead: turn.cacheRead,
        cacheWrite: turn.cacheWrite,
        output: turn.output,
        total: turn.total,
        cny: money4(turn.cny),
        messages: turn.messages,
        open: turn.open,
      })
    }
    if (used > 0) {
      sessionRows.push({
        sessionId: session.sessionId,
        title: session.title,
        workspace: session.workspace,
        depth: session.depth,
        ...sessionTotals,
      })
    }
  }

  for (const [key, bucket] of periods) bucket.sessions = periodSessions.get(key).size

  const periodList = [...periods.values()].sort((left, right) => right.from - left.from)
  details.sort((left, right) => right.time - left.time)
  sessionRows.sort((left, right) => right.cny - left.cny)

  const truncated = args.full === true ? false : details.length > DETAIL_LIMIT
  const elapsed = Date.now() - started
  if (elapsed > 1500) trace(`ledger slow: ${elapsed}ms files=${files.length}`)

  return {
    at: Date.now(),
    groupBy,
    range,
    periods: periodList,
    details: truncated ? details.slice(0, DETAIL_LIMIT) : details,
    truncated,
    detailCount: details.length,
    sessions: sessionRows,
    totals,
    coverage: {
      files: files.length,
      scanned,
      skipped,
      inheritedMessages: inherited,
      withUsage: sessionRows.length,
      oldest,
      newest,
    },
    pricing: {
      source: BUILTIN_PRICING.source,
      fetchedAt: pricingState.fetchedAt,
      mode: pricingState.mode,
      syncedAt: pricingState.syncedAt,
      syncError: pricingState.error,
      currency: BUILTIN_PRICING.currency,
      note: BUILTIN_PRICING.note,
      holidayYears,
    },
    elapsed,
  }
}

// ---------- 账户余额 ----------
// 走 DSH 自己的账号服务：deepseekAccount.getBalance(client)。
// 它用本机已登录的凭证去 Platform 查「充值钱包 + 赠金钱包」，
// 跟「设置 → 账户」页同一个来源；插件不接触 token，也不做任何登录动作。
let accountService = null
const BALANCE_TTL_MS = 25 * 1000
let balanceCache = { at: 0, value: null }
let balanceInflight = null
let previousBalanceKey = ''

function clientMetadata() {
  // Platform 用这三个字段识别「哪个界面在问」；时区偏移按「东为正」的秒数。
  return {
    version: VERSION,
    locale: 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

function walletList(list) {
  if (!Array.isArray(list)) return []
  return list
    .filter((row) => row && typeof row.balance === 'string')
    .map((row) => ({
      currency: row.currency === 'USD' ? 'USD' : 'CNY',
      balance: Number(row.balance),
      raw: row.balance,
    }))
    .filter((row) => Number.isFinite(row.balance))
}

function sumByCurrency(wallets) {
  const out = {}
  for (const wallet of wallets) out[wallet.currency] = (out[wallet.currency] ?? 0) + wallet.balance
  return out
}

async function readBalance(force = false) {
  const now = Date.now()
  if (!force && balanceCache.value !== null && now - balanceCache.at < BALANCE_TTL_MS) {
    return { ...balanceCache.value, cached: true }
  }
  if (balanceInflight !== null) return balanceInflight
  if (accountService === null) {
    return {
      status: 'unavailable',
      at: now,
      cached: false,
      reason: '账号服务还没就绪（DSH 未注入 deepseekAccount）',
      wallets: [],
      bonus: [],
      total: {},
      bonusTotal: {},
      updatedAt: 0,
    }
  }
  balanceInflight = (async () => {
    const at = Date.now()
    try {
      const raw = await accountService.getBalance(clientMetadata())
      const wallets = walletList(raw?.value)
      const bonus = walletList(raw?.bonusWallets)
      let status = 'ready'
      let reason = ''
      if (raw === null || raw === undefined) {
        status = 'signed-out'
        reason = '本机没有登录账号，读不到余额'
        try {
          const state = await accountService.getState()
          if (state?.status === 'credential-stored') {
            status = 'signed-out'
            reason = '凭证已失效，请到「设置 → 账户」重新登录'
          }
        } catch {
          // 状态也问不到就保持原样
        }
      } else if (raw.status !== 'ready') {
        status = 'failed'
        reason = '查询余额失败（网络或账号服务返回失败）'
      }
      const value = {
        status,
        at,
        cached: false,
        reason,
        wallets,
        bonus,
        total: sumByCurrency(wallets),
        bonusTotal: sumByCurrency(bonus),
        updatedAt: at,
      }
      balanceCache = { at, value }
      // 只在余额变化或状态变化时留痕：平时每 30 秒一次，写日志没意义。
      const key = `${status}:${JSON.stringify(value.total)}:${JSON.stringify(value.bonusTotal)}`
      if (key !== previousBalanceKey) {
        previousBalanceKey = key
        trace(
          `balance ${status} total=${JSON.stringify(value.total)} bonus=${JSON.stringify(value.bonusTotal)}${
            reason ? ` reason=${reason}` : ''
          }`,
        )
      }
      return value
    } catch (error) {
      const value = {
        status: 'failed',
        at,
        cached: false,
        reason: String(error?.message ?? error),
        wallets: [],
        bonus: [],
        total: {},
        bonusTotal: {},
        updatedAt: at,
      }
      balanceCache = { at, value }
      trace(`balance failed: ${value.reason}`)
      return value
    } finally {
      balanceInflight = null
    }
  })()
  return balanceInflight
}

// ---------- Excel 导出 ----------
// 不引第三方库：手写一个「只存不压」的 zip + SpreadsheetML。
// 三个工作表：汇总 / 明细 / 按会话。数字都是真数字（不是文本），Excel 里能直接再算。

const CELL = {
  DEFAULT: 0,
  TITLE: 1,
  HEAD: 2,
  TEXT: 3,
  INT: 4,
  MONEY4: 5,
  MONEY2: 6,
  NOTE: 7,
  BOLD_INT: 8,
  BOLD_MONEY2: 9,
  BOLD_TEXT: 10,
  PERCENT: 11,
  BOLD_PERCENT: 12,
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 只存不压的 zip（xlsx 允许）。Excel / WPS / LibreOffice 都认。 */
function zipStore(entries) {
  const now = new Date()
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xffff
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.data
    const compressed = deflateRawSync(data, { level: 9 })
    const useDeflate = compressed.length > 0 && compressed.length < data.length
    const payload = useDeflate ? compressed : data
    const method = useDeflate ? 8 : 0
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + payload.length
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, ...centralParts, end])
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // XML 1.0 不允许的控制字符：宁可丢，也不要让整本打不开
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

function colName(index) {
  let value = index
  let name = ''
  while (value > 0) {
    const rest = (value - 1) % 26
    name = String.fromCharCode(65 + rest) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}

/** 一个单元格：数字走 <v>，文字走 inlineStr（不依赖 sharedStrings）。 */
function cellXml(ref, value, style) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}" s="${style}"><v>${value}</v></c>`
  }
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`
}

function sheetXml(options) {
  const { rows, cols, merges = [], freeze = 0, filter = '', selected = false } = options
  const body = rows
    .map((row, rowIndex) => {
      const r = rowIndex + 1
      const cells = (row.cells ?? [])
        .map((cell, columnIndex) => {
          if (cell === null || cell === undefined) return ''
          if (typeof cell === 'object') {
            return cellXml(`${colName(columnIndex + 1)}${r}`, cell.v, cell.s ?? CELL.DEFAULT)
          }
          return cellXml(`${colName(columnIndex + 1)}${r}`, cell, typeof cell === 'number' ? CELL.INT : CELL.TEXT)
        })
        .join('')
      const height = row.height ? ` ht="${row.height}" customHeight="1"` : ''
      return `<row r="${r}"${height}>${cells}</row>`
    })
    .join('')
  const colsXml =
    Array.isArray(cols) && cols.length > 0
      ? `<cols>${cols
          .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
          .join('')}</cols>`
      : ''
  const view =
    freeze > 0
      ? `<sheetViews><sheetView${selected ? ' tabSelected="1"' : ''} workbookViewId="0"><pane ySplit="${freeze}" topLeftCell="A${
          freeze + 1
        }" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${freeze + 1}" sqref="A${freeze + 1}"/></sheetView></sheetViews>`
      : `<sheetViews><sheetView${selected ? ' tabSelected="1"' : ''} workbookViewId="0"/></sheetViews>`
  const filterXml = filter === '' ? '' : `<autoFilter ref="${filter}"/>`
  const mergeXml =
    merges.length === 0
      ? ''
      : `<mergeCells count="${merges.length}">${merges.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`
  // 打印用 A4 横向、按一页宽缩放；表头行在 pageSetup 里靠 workbook 的 Print_Titles 重复。
  return `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>${view}<sheetFormatPr defaultRowHeight="16"/>${colsXml}<sheetData>${body}</sheetData>${filterXml}${mergeXml}<printOptions horizontalCentered="1"/><pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`
}

const STYLES_XML = `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="0.0000"/><numFmt numFmtId="165" formatCode="0.00%"/></numFmts>
<fonts count="4">
<font><name val="微软雅黑"/><charset val="134"/><sz val="10"/></font>
<font><name val="微软雅黑"/><charset val="134"/><b/><sz val="10"/></font>
<font><name val="微软雅黑"/><charset val="134"/><b/><color rgb="FF1F4E79"/><sz val="16"/></font>
<font><name val="微软雅黑"/><charset val="134"/><i/><color rgb="FF808080"/><sz val="9"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="13">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="4" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="3" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="4" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="165" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`

/**
 * 人民币金额大写（报销单用）。只到「分」，四舍五入。
 * @param value - 元，可以是小数。
 * @returns 例：1.05 → 壹元零伍分；0.05 → 伍分；10 → 壹拾元整。
 */
export function cnyUpper(value) {
  const digits = '零壹贰叁肆伍陆柒捌玖'
  const units = ['', '拾', '佰', '仟', '万', '拾', '佰', '仟', '亿', '拾', '佰', '仟', '万亿']
  const cents = Math.round((Number.isFinite(value) ? value : 0) * 100)
  if (!(cents > 0)) return '零元整'
  const yuan = Math.floor(cents / 100)
  const jiao = Math.floor(cents / 10) % 10
  const fen = cents % 10

  let integer = ''
  if (yuan > 0) {
    const text = String(yuan)
    let zero = false
    for (let index = 0; index < text.length; index += 1) {
      const digit = Number(text[index])
      const position = text.length - 1 - index
      if (digit === 0) {
        zero = true
      } else {
        if (zero && integer !== '') integer += '零'
        zero = false
        integer += digits[digit] + units[position]
      }
    }
    integer += '元'
  }

  if (jiao === 0 && fen === 0) return `${integer}整`
  let out = integer
  if (jiao > 0) out += `${digits[jiao]}角`
  else if (yuan > 0) out += '零'
  if (fen > 0) out += `${digits[fen]}分`
  return out
}

/** 把账本拼成一本 xlsx。 */
export function buildWorkbook(ledger) {
  const groupBy = ledger.groupBy
  const monthly = groupBy !== 'week'
  const range = ledger.range
  const from =
    range.from > 0
      ? beijingStamp(range.from).date
      : ledger.coverage.oldest > 0
        ? beijingStamp(ledger.coverage.oldest).date
        : '不限'
  const to = beijingStamp(range.to).date
  const now = beijingStamp(Date.now(), true)
  const periodMoney = ledger.periods.map((period) => money4(period.cny))
  const detailMoney = ledger.details.map((detail) => money4(detail.cny))
  const summaryTotal = money4(periodMoney.reduce((sum, value) => sum + value, 0))
  const detailTotal = money4(detailMoney.reduce((sum, value) => sum + value, 0))
  const totalRow = ledger.totals
  const periodTitle = monthly ? '按月' : '按周'

  // ---- 汇总 ----
  const summaryRows = [
    { cells: [{ v: `DSH 用量费用汇总（${periodTitle}）`, s: CELL.TITLE }], height: 26 },
    { cells: [{ v: `统计区间：${from} 至 ${to}（${range.label}）`, s: CELL.NOTE }] },
    {
      cells: [
        {
          v: `计价口径：官方价目 ${ledger.pricing.fetchedAt}；逐条消息按北京时间判峰谷（周一至周五 9:00–12:00、14:00–18:00 为高峰，法定节假日已扣除）；缓存写入按未命中输入计价。`,
          s: CELL.NOTE,
        },
      ],
    },
    {
      cells: [
        {
          v: `合计金额：¥${summaryTotal.toFixed(2)}（大写：${cnyUpper(summaryTotal)}）`,
          s: CELL.NOTE,
        },
      ],
    },
    {
      cells: [
        {
          v: `生成时间：${now.stamp} · 覆盖 ${ledger.coverage.withUsage} 个会话 · 金额按当前价目重算，不是当时账单快照`,
          s: CELL.NOTE,
        },
      ],
    },
    { cells: [] },
    {
      cells: [
        { v: '期间', s: CELL.HEAD },
        { v: '金额（元）', s: CELL.HEAD },
        { v: '占比', s: CELL.HEAD },
        { v: '轮次', s: CELL.HEAD },
        { v: '调用次数', s: CELL.HEAD },
        { v: '合计 tokens', s: CELL.HEAD },
        { v: '输入', s: CELL.HEAD },
        { v: '缓存读', s: CELL.HEAD },
        { v: '输出', s: CELL.HEAD },
        { v: '会话数', s: CELL.HEAD },
      ],
      height: 30,
    },
  ]
  ledger.periods.forEach((period, index) => {
    summaryRows.push({
      cells: [
        { v: period.label, s: CELL.TEXT },
        { v: periodMoney[index], s: CELL.MONEY2 },
        { v: totalRow.cny > 0 ? Math.min(1, period.cny / totalRow.cny) : 0, s: CELL.PERCENT },
        { v: period.turns, s: CELL.INT },
        { v: period.messages, s: CELL.INT },
        { v: period.total, s: CELL.INT },
        { v: period.input, s: CELL.INT },
        { v: period.cacheRead, s: CELL.INT },
        { v: period.output, s: CELL.INT },
        { v: period.sessions, s: CELL.INT },
      ],
    })
  })
  if (ledger.periods.length === 0) {
    summaryRows.push({ cells: [{ v: '这个区间没有可统计的轮次', s: CELL.TEXT }] })
  }
  summaryRows.push({
    cells: [
      { v: '合计', s: CELL.BOLD_TEXT },
      { v: summaryTotal, s: CELL.BOLD_MONEY2 },
      { v: 1, s: CELL.BOLD_PERCENT },
      { v: totalRow.turns, s: CELL.BOLD_INT },
      { v: totalRow.messages, s: CELL.BOLD_INT },
      { v: totalRow.total, s: CELL.BOLD_INT },
      { v: totalRow.input, s: CELL.BOLD_INT },
      { v: totalRow.cacheRead, s: CELL.BOLD_INT },
      { v: totalRow.output, s: CELL.BOLD_INT },
      { v: '', s: CELL.BOLD_TEXT },
    ],
  })
  summaryRows.push({ cells: [] })
  summaryRows.push({
    cells: [
      {
        v: `说明：占比按金额算；金额按每条 4 位小数落定后逐行相加，合计行与明细列严格对得上；汇总列按 2 位显示。会话数按「该期间有使用的会话」计，跨期的会话会在两边各出现一次（去重后共 ${ledger.coverage.withUsage} 个），所以合计行不填会话数。`,
        s: CELL.NOTE,
      },
    ],
  })
  summaryRows.push({
    cells: [
      {
        v: `本表只统计本机会话日志（${ledger.coverage.files} 个文件，读取失败 ${ledger.coverage.skipped} 个）；子会话单独计入，不与主会话重复。${
          ledger.coverage.inheritedMessages > 0
            ? `分叉会话里抄来的 ${ledger.coverage.inheritedMessages} 条历史消息不计（那部分已算在父会话）。`
            : ''
        }${totalRow.unpriced > 0 ? `另有 ${totalRow.unpriced} 条消息的模型不在价目表，金额未计入。` : ''}`,
        s: CELL.NOTE,
      },
    ],
  })

  const summarySheet = sheetXml({
    rows: summaryRows,
    cols: [16, 13, 8, 8, 10, 14, 13, 14, 12, 8],
    merges: ['A1:J1'],
    freeze: 7,
    selected: true,
  })

  // ---- 明细 ----
  const detailRows = [
    {
      cells: [
        { v: '日期', s: CELL.HEAD },
        { v: '时间', s: CELL.HEAD },
        { v: '会话', s: CELL.HEAD },
        { v: '工作区', s: CELL.HEAD },
        { v: '轮次', s: CELL.HEAD },
        { v: '模型', s: CELL.HEAD },
        { v: '输入', s: CELL.HEAD },
        { v: '缓存读', s: CELL.HEAD },
        { v: '写缓存', s: CELL.HEAD },
        { v: '输出', s: CELL.HEAD },
        { v: '合计 tokens', s: CELL.HEAD },
        { v: '金额（元）', s: CELL.HEAD },
      ],
      height: 28,
    },
  ]
  ledger.details.forEach((detail, index) => {
    const stamp = beijingStamp(detail.time, true)
    detailRows.push({
      cells: [
        { v: stamp.date, s: CELL.TEXT },
        { v: stamp.time, s: CELL.TEXT },
        { v: detail.title, s: CELL.TEXT },
        { v: detail.workspace, s: CELL.TEXT },
        { v: detail.turn, s: CELL.INT },
        { v: detail.model || '—', s: CELL.TEXT },
        { v: detail.input, s: CELL.INT },
        { v: detail.cacheRead, s: CELL.INT },
        { v: detail.cacheWrite, s: CELL.INT },
        { v: detail.output, s: CELL.INT },
        { v: detail.total, s: CELL.INT },
        { v: detailMoney[index], s: CELL.MONEY4 },
      ],
    })
  })
  detailRows.push({
    cells: [
      { v: '合计', s: CELL.BOLD_TEXT },
      { v: '', s: CELL.BOLD_TEXT },
      { v: '', s: CELL.BOLD_TEXT },
      { v: '', s: CELL.BOLD_TEXT },
      { v: totalRow.turns, s: CELL.BOLD_INT },
      { v: '', s: CELL.BOLD_TEXT },
      { v: totalRow.input, s: CELL.BOLD_INT },
      { v: totalRow.cacheRead, s: CELL.BOLD_INT },
      { v: totalRow.cacheWrite, s: CELL.BOLD_INT },
      { v: totalRow.output, s: CELL.BOLD_INT },
      { v: totalRow.total, s: CELL.BOLD_INT },
      { v: detailTotal, s: CELL.BOLD_MONEY2 },
    ],
  })

  const detailSheet = sheetXml({
    rows: detailRows,
    cols: [11, 10, 30, 24, 7, 18, 12, 13, 10, 11, 13, 12],
    freeze: 1,
    filter: `A1:L${Math.max(1, detailRows.length - 1)}`,
  })

  // ---- 按会话 ----
  const sessionRows = [
    {
      cells: [
        { v: '会话', s: CELL.HEAD },
        { v: '工作区', s: CELL.HEAD },
        { v: '类型', s: CELL.HEAD },
        { v: '轮次', s: CELL.HEAD },
        { v: '合计 tokens', s: CELL.HEAD },
        { v: '金额（元）', s: CELL.HEAD },
        { v: '首次', s: CELL.HEAD },
        { v: '末次', s: CELL.HEAD },
      ],
      height: 28,
    },
  ]
  for (const session of ledger.sessions) {
    const own = ledger.details.filter((detail) => detail.sessionId === session.sessionId)
    const first = own.length > 0 ? Math.min(...own.map((detail) => detail.time)) : 0
    const last = own.length > 0 ? Math.max(...own.map((detail) => detail.time)) : 0
    sessionRows.push({
      cells: [
        { v: session.title, s: CELL.TEXT },
        { v: session.workspace, s: CELL.TEXT },
        { v: session.depth > 0 ? '子会话' : '主会话', s: CELL.TEXT },
        { v: session.turns, s: CELL.INT },
        { v: session.total, s: CELL.INT },
        { v: money4(session.cny), s: CELL.MONEY2 },
        { v: first > 0 ? beijingStamp(first).stamp : '—', s: CELL.TEXT },
        { v: last > 0 ? beijingStamp(last).stamp : '—', s: CELL.TEXT },
      ],
    })
  }
  sessionRows.push({
    cells: [
      { v: '合计', s: CELL.BOLD_TEXT },
      { v: '', s: CELL.BOLD_TEXT },
      { v: '', s: CELL.BOLD_TEXT },
      { v: totalRow.turns, s: CELL.BOLD_INT },
      { v: totalRow.total, s: CELL.BOLD_INT },
      { v: money4(totalRow.cny), s: CELL.BOLD_MONEY2 },
      { v: '', s: CELL.BOLD_TEXT },
      { v: '', s: CELL.BOLD_TEXT },
    ],
  })

  const sessionSheet = sheetXml({
    rows: sessionRows,
    cols: [34, 14, 8, 7, 14, 12, 18, 18],
    freeze: 1,
    filter: `A1:H${Math.max(1, sessionRows.length - 1)}`,
  })

  const printTitles = `<definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">'${periodTitle}汇总'!$7:$7</definedName><definedName name="_xlnm.Print_Titles" localSheetId="1">'费用明细'!$1:$1</definedName><definedName name="_xlnm.Print_Titles" localSheetId="2">'按会话'!$1:$1</definedName></definedNames>`

  const workbook = `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${periodTitle}汇总" sheetId="1" r:id="rId1"/><sheet name="费用明细" sheetId="2" r:id="rId2"/><sheet name="按会话" sheetId="3" r:id="rId3"/></sheets>${printTitles}</workbook>`

  const workbookRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`

  const rootRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`

  const contentTypes = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`

  return zipStore([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(summarySheet, 'utf8') },
    { name: 'xl/worksheets/sheet2.xml', data: Buffer.from(detailSheet, 'utf8') },
    { name: 'xl/worksheets/sheet3.xml', data: Buffer.from(sessionSheet, 'utf8') },
  ])
}

function exportName(ledger) {
  const day = beijingStamp(Date.now()).date.replace(/-/g, '')
  return `token-bill-${ledger.groupBy}-${day}.xlsx`
}

// ---------- 对外 ----------

/** Test seam: peak/holiday logic is worth asserting from outside without a session. */
export const debug = {
  isPeak,
  isHoliday,
  beijingDay,
  holidayYears,
  periodOf,
  resolveRange,
  cnyUpper,
  /** 让验证脚本塞一个假的账号服务，不必真的登录。 */
  setAccountService(service) {
    accountService = service ?? null
    balanceCache = { at: 0, value: null }
    previousBalanceKey = ''
  },
}

/** Local verification entry — the route calls exactly these. */
export const handlers = {
  // 每次问数据前先按需同步价目（有缓存，不会每次都联网）。
  turns: async (args) => {
    await ensurePricing(false)
    return turnsOf(args?.sessionId)
  },
  // 面板上的「立刻同步价目」。
  refreshPricing: async () => {
    const state = await ensurePricing(true)
    return {
      ok: true,
      value: {
        mode: state.mode,
        fetchedAt: state.fetchedAt,
        syncedAt: state.syncedAt,
        error: state.error,
        models: state.table.models.map((entry) => ({
          id: entry.id,
          hit: entry.hit,
          miss: entry.miss,
          out: entry.out,
        })),
      },
    }
  },
  // 账户余额（充值钱包 + 赠金钱包）。
  balance: async (args) => {
    const value = await readBalance(args?.force === true)
    return { ok: true, value }
  },
  // 按月 / 按周账本 + 逐轮明细。
  ledger: async (args) => {
    await ensurePricing(false)
    return { ok: true, value: collectLedger(args ?? {}) }
  },
}

function envelope(value) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function handleRequest(request) {
  let payload
  try {
    payload = await request.json()
  } catch {
    trace('request body is not JSON')
    return envelope({ ok: false, error: { code: 'bad-request', message: 'body is not JSON' } })
  }
  const endpoint = payload?.endpoint
  const handler = typeof endpoint === 'string' && Object.hasOwn(handlers, endpoint) ? handlers[endpoint] : undefined
  if (handler === undefined) {
    trace(`unknown endpoint: ${String(endpoint)}`)
    return envelope({ ok: false, error: { code: 'bad-request', message: `unknown endpoint: ${String(endpoint)}` } })
  }
  try {
    const result = await handler(payload?.args ?? {})
    // handler 已经返回 { ok, value | error }，外面不再套一层信封 ——
    // 套两层会让客户端拿到 { ok, value: { ok, value } }，turns 就是 undefined。
    // 只在失败时留痕：成功每 4 秒一次，写日志没有意义。
    if (result?.ok !== true) trace(`handler failed: ${result?.error ?? 'unknown'}`)
    return envelope(result)
  } catch (error) {
    trace(`handler threw: ${error?.message ?? error}`)
    return envelope({ ok: false, error: { code: 'internal', message: error?.message ?? String(error) } })
  }
}

async function handleExport(request) {
  let payload
  try {
    payload = await request.json()
  } catch {
    return envelope({ ok: false, error: { code: 'bad-request', message: 'body is not JSON' } })
  }
  try {
    await ensurePricing(false)
    const ledger = collectLedger({ ...(payload ?? {}), full: true })
    const buffer = buildWorkbook(ledger)
    trace(`export ${ledger.groupBy} rows=${ledger.details.length} bytes=${buffer.length}`)
    return new Response(buffer, {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${exportName(ledger)}"`,
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    trace(`export failed: ${error?.message ?? error}`)
    return new Response(JSON.stringify({ ok: false, error: { code: 'internal', message: error?.message ?? String(error) } }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}

export function apply(ctx) {
  trace(`apply ran (v${VERSION} · 曲线 + 账单 + 余额)`)

  // 账号服务：有就用，没有不影响曲线与账本。
  try {
    ctx.inject(['deepseekAccount'], (accountCtx) => {
      accountService = accountCtx.deepseekAccount ?? null
      trace('account service injected')
    })
  } catch (error) {
    trace(`account inject failed: ${error?.message ?? error}`)
  }

  try {
    ctx.inject(['connection'], (connectionCtx) => {
      trace('connection injected')
      connectionCtx.effect(
        () => {
          const handle = connectionCtx.connection.fetch.register({
            path: ROUTE,
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: (request) => handleRequest(request),
          })
          trace('route registered')
          return handle
        },
        'dsh-token-curve: token route',
      )
      connectionCtx.effect(
        () =>
          connectionCtx.connection.fetch.register({
            path: EXPORT_ROUTE,
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: (request) => handleExport(request),
          }),
        'dsh-token-curve: export route',
      )
    })
  } catch (error) {
    trace(`apply threw: ${error?.message ?? error}`)
  }
}
