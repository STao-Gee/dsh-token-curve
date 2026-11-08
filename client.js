// dsh-token-curve · 界面层（浏览器半边）
//
// 右栏一个独立 tab：当前对话「每一轮消耗多少 token / 花了多少钱」画成柱 + 累计曲线，
// 顶上给本对话的累计；点曲线上任意一轮的节点（或表格那一行），展开那一轮的完整明细。
//
// 数据全部来自宿主路由 /api/token-curve（同源 POST），那条路由按会话日志里
// 每条 assistant/message 上报的 usage 逐轮相加、逐条判峰谷计价 —— 是账单，不是估算。
//
// 快捷键：默认 Ctrl+Shift+U（浏览器里 Ctrl+Alt+U），可在 设置 → 快捷键 里改成顺手的键。
// 默认不自动打开：右栏常常被文件/终端占着，开不开由你按。
window.__ModuleLoader__.load({
  id: 'dsh-token-curve',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React

    // ---------- 身份 ----------
    const TYPE_ID = 'dsh-token-curve/panel'
    const KIND = 'token-curve'
    const TITLE = 'Token 曲线'
    const API = '/api/token-curve'
    const EXPORT_API = '/api/token-curve-export'
    const POLL_MS = 4000
    const BALANCE_POLL_MS = 30000
    const LEDGER_POLL_MS = 60000

    // 注册结果只有一个地方能看见（浏览器控制台），所以留一份给面板自报。
    const runtime = { shortcut: '未绑定' }

    // 右栏控制器：inject 回调拿到后存这里，全局热键要用它。
    let navRef = null

    // ---------- 开关键 ----------
    // 用它自己的键，不走 shortcuts 服务：服务按 id 去重，而热重载时旧实例的
    // 注销没跑干净，第二次注册就 Duplicate 了。自己存 localStorage 反而能
    // 让用户按一下键盘就改键，不依赖设置页。
    const KEY_STORE = 'dsh-token-curve:hotkey'
    const DEFAULT_HOTKEY = { mods: ['ctrl', 'alt'], code: 'KeyU' }

    const codeLabel = (code) => {
      if (/^Key[A-Z]$/.test(code)) return code.slice(3)
      if (/^Digit[0-9]$/.test(code)) return code.slice(5)
      if (/^F\d{1,2}$/.test(code)) return code
      const named = {
        Comma: ',',
        Period: '.',
        Slash: '/',
        Semicolon: ';',
        Quote: "'",
        BracketLeft: '[',
        BracketRight: ']',
        Backslash: '\\',
        Backquote: '`',
        Minus: '-',
        Equal: '=',
        Space: 'Space',
        Enter: 'Enter',
        Tab: 'Tab',
      }
      return named[code] ?? code
    }

    const hotkeyLabel = (spec) => {
      const order = ['ctrl', 'alt', 'shift', 'meta']
      const names = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' }
      const mods = order.filter((mod) => spec.mods.includes(mod)).map((mod) => names[mod])
      return [...mods, codeLabel(spec.code)].join('+')
    }

    const readHotkey = () => {
      try {
        const raw = window.localStorage.getItem(KEY_STORE)
        if (raw) {
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed.code === 'string' && Array.isArray(parsed.mods) && parsed.mods.length > 0) {
            return { mods: parsed.mods, code: parsed.code }
          }
        }
      } catch (error) {
        // 读不到就用默认
      }
      return { ...DEFAULT_HOTKEY }
    }

    const writeHotkey = (spec) => {
      try {
        window.localStorage.setItem(KEY_STORE, JSON.stringify(spec))
      } catch (error) {
        // 存不了不影响本次会话
      }
    }

    // 单位口径：zh = 万/亿（默认），en = K/M/B。记在浏览器本地。
    const UNITS_STORE = 'dsh-token-curve:units'
    const readUnits = () => {
      try {
        return window.localStorage.getItem(UNITS_STORE) === 'en' ? 'en' : 'zh'
      } catch (error) {
        return 'zh'
      }
    }
    const writeUnits = (mode) => {
      try {
        window.localStorage.setItem(UNITS_STORE, mode)
      } catch (error) {
        // 存不了不影响本次会话
      }
    }

    const hotkeyMatches = (event, spec) =>
      event.code === spec.code &&
      event.ctrlKey === spec.mods.includes('ctrl') &&
      event.altKey === spec.mods.includes('alt') &&
      event.shiftKey === spec.mods.includes('shift') &&
      event.metaKey === spec.mods.includes('meta')

    // ---------- 小工具 ----------
    const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
    const safe = (fn, fallback) => {
      try {
        return fn()
      } catch (error) {
        return fallback
      }
    }

    // ---------- 数字单位 ----------
    // 中文口径：<1万 显示实际值；1万~1亿 用「万」(2 位小数)；≥1亿 用「亿」(4 位小数)。
    // 英文口径：<1千 实际值；1千~100万 用 K(2 位)；≥100万 用 M(2 位)；≥10亿 用 B(2 位)。
    // 外面的 verify-units.mjs 会按下面两行标记把函数抠出来单测，改的时候别动标记。
    // --- formatTokenValue start ---
    function formatTokenValue(value, mode) {
      const n = typeof value === 'number' && Number.isFinite(value) ? value : 0
      if (n <= 0) return '0'
      if (mode === 'en') {
        if (n < 1000) return String(Math.round(n))
        if (n < 1e6) return (n / 1e3).toFixed(2) + 'K'
        if (n < 1e9) return (n / 1e6).toFixed(2) + 'M'
        return (n / 1e9).toFixed(2) + 'B'
      }
      if (n < 10000) return Math.round(n).toLocaleString('zh-CN')
      if (n < 1e8) return (n / 1e4).toFixed(2) + '万'
      return (n / 1e8).toFixed(4) + '亿'
    }
    // --- formatTokenValue end ---

    const fmtExact = (value) => Math.round(num(value)).toLocaleString('zh-CN')

    const fmtCny = (value) => {
      const n = num(value)
      if (n <= 0) return '0'
      if (n < 0.01) return n.toFixed(4)
      if (n < 1) return n.toFixed(3)
      if (n < 1000) return n.toFixed(2)
      return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
    }

    const pct = (part, whole) => {
      if (!(whole > 0)) return '—'
      const ratio = part / whole
      return (ratio >= 0.995 ? '100' : (ratio * 100).toFixed(1)) + '%'
    }

    const clockOf = (time) => {
      if (!(time > 0)) return ''
      const date = new Date(time)
      if (Number.isNaN(date.getTime())) return ''
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
    }

    // ---------- 数据结构 ----------
    const bucketsOf = (turn) => {
      const input = num(turn?.input)
      const cacheRead = num(turn?.cacheRead)
      const cacheWrite = num(turn?.cacheWrite)
      const output = num(turn?.output)
      const total = num(turn?.total) || input + cacheRead + cacheWrite + output
      const promptSide = input + cacheRead + cacheWrite
      return {
        turn: num(turn?.turn),
        input,
        cacheRead,
        cacheWrite,
        output,
        total,
        promptSide,
        displayInput: input + cacheWrite,
        cny: num(turn?.cny),
        pricedMessages: num(turn?.pricedMessages),
        unpricedMessages: num(turn?.unpricedMessages),
        peakMessages: num(turn?.peakMessages),
        offPeakMessages: num(turn?.offPeakMessages),
        open: turn?.open === true,
        messages: num(turn?.messages),
        startTime: num(turn?.startTime),
        endTime: num(turn?.endTime),
        models: Array.isArray(turn?.models) ? turn.models : [],
      }
    }

    // ---------- 取数 ----------
    async function callEndpoint(endpoint, args, signal) {
      const response = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, args: args ?? {} }),
        signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const envelope = await response.json()
      if (!envelope || envelope.ok !== true) throw new Error(envelope?.error?.message ?? '宿主没有返回数据')
      return envelope.value
    }

    const callRoute = (sessionId, signal) => callEndpoint('turns', { sessionId }, signal)

    const documentHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

    function useTurns(sessionId) {
      const [state, setState] = useState({ status: 'idle', data: null, error: '' })
      const [tick, setTick] = useState(0)
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      useEffect(() => {
        if (!sessionId) {
          setState({ status: 'idle', data: null, error: '' })
          return undefined
        }
        const controller = new AbortController()
        setState((previous) => ({ ...previous, status: previous.data ? 'refreshing' : 'loading' }))
        callRoute(sessionId, controller.signal)
          .then((data) => {
            if (!alive.current) return
            setState({ status: 'ready', data, error: '' })
          })
          .catch((error) => {
            if (!alive.current || controller.signal.aborted) return
            setState((previous) => ({ status: 'error', data: previous.data, error: error?.message ?? String(error) }))
          })
        return () => controller.abort()
      }, [sessionId, tick])

      useEffect(() => {
        if (!sessionId) return undefined
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          setTick((value) => value + 1)
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [sessionId])

      const refresh = useCallback(() => setTick((value) => value + 1), [])
      return { ...state, refresh }
    }

    // 账户余额：宿主问 DSH 账号服务，面板只负责显示；30 秒自己刷一次。
    function useBalance() {
      const [state, setState] = useState({ status: 'idle', data: null, error: '' })
      const [tick, setTick] = useState(0)
      const force = useRef(false)
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      useEffect(() => {
        const controller = new AbortController()
        const hard = force.current === true
        force.current = false
        setState((previous) => ({ ...previous, status: previous.data ? 'refreshing' : 'loading' }))
        callEndpoint('balance', { force: hard }, controller.signal)
          .then((data) => {
            if (!alive.current) return
            setState({ status: 'ready', data, error: '' })
          })
          .catch((error) => {
            if (!alive.current || controller.signal.aborted) return
            setState((previous) => ({ status: 'error', data: previous.data, error: error?.message ?? String(error) }))
          })
        return () => controller.abort()
      }, [tick])

      useEffect(() => {
        const timer = setInterval(() => {
          if (documentHidden()) return
          setTick((value) => value + 1)
        }, BALANCE_POLL_MS)
        return () => clearInterval(timer)
      }, [])

      const refresh = useCallback((hard) => {
        force.current = hard === true
        setTick((value) => value + 1)
      }, [])
      return { ...state, refresh }
    }

    // 账本：本机全部会话按区间汇总（默认只在你切到「账单」时才读）。
    function useLedger(groupBy, range, enabled) {
      const [state, setState] = useState({ status: 'idle', data: null, error: '' })
      const [tick, setTick] = useState(0)
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      useEffect(() => {
        if (!enabled) return undefined
        const controller = new AbortController()
        setState((previous) => ({ ...previous, status: previous.data ? 'refreshing' : 'loading' }))
        callEndpoint('ledger', { groupBy, range }, controller.signal)
          .then((data) => {
            if (!alive.current) return
            setState({ status: 'ready', data, error: '' })
          })
          .catch((error) => {
            if (!alive.current || controller.signal.aborted) return
            setState((previous) => ({ status: 'error', data: previous.data, error: error?.message ?? String(error) }))
          })
        return () => controller.abort()
      }, [enabled, groupBy, range, tick])

      useEffect(() => {
        if (!enabled) return undefined
        const timer = setInterval(() => {
          if (documentHidden()) return
          setTick((value) => value + 1)
        }, LEDGER_POLL_MS)
        return () => clearInterval(timer)
      }, [enabled])

      const refresh = useCallback(() => setTick((value) => value + 1), [])
      return { ...state, refresh }
    }

    // ---------- 绘图 ----------
    // 单调三次插值：累计只涨不跌，普通贝塞尔会在拐点冲过头（画出「回撤」）。
    const smoothPath = (points) => {
      if (points.length === 0) return ''
      if (points.length === 1) return `M${points[0][0]},${points[0][1]}`
      const slopes = []
      for (let index = 1; index < points.length; index += 1) {
        const dx = points[index][0] - points[index - 1][0]
        slopes.push(dx === 0 ? 0 : (points[index][1] - points[index - 1][1]) / dx)
      }
      let path = `M${points[0][0]},${points[0][1]}`
      for (let index = 1; index < points.length; index += 1) {
        const [x0, y0] = points[index - 1]
        const [x1, y1] = points[index]
        const start = slopes[index - 2] ?? slopes[index - 1]
        const end = slopes[index - 1] ?? slopes[index - 2]
        const dx = (x1 - x0) / 3
        path += ` C${x0 + dx},${y0 + start * dx} ${x1 - dx},${y1 - end * dx} ${x1},${y1}`
      }
      return path
    }

    const TOKEN_SERIES = [
      { key: 'input', label: '输入', className: 'tkc-input' },
      { key: 'cacheRead', label: '缓存读', className: 'tkc-cache' },
      { key: 'output', label: '输出', className: 'tkc-output' },
      { key: 'cumulative', label: '累计', className: 'tkc-cum' },
    ]

    const CNY_SERIES = [
      { key: 'cost', label: '每轮', className: 'tkc-cost' },
      { key: 'cumulative', label: '累计', className: 'tkc-cum' },
    ]

    const useElementWidth = (ref) => {
      const [width, setWidth] = useState(0)
      useEffect(() => {
        const element = ref.current
        if (!element) return undefined
        setWidth(element.clientWidth)
        if (typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const next = Math.round(entry.contentRect.width)
            if (next > 0) setWidth(next)
          }
        })
        observer.observe(element)
        return () => observer.disconnect()
      }, [ref])
      return width
    }

    function TokenChart({ turns, width, metric, visible, hover, setHover, selected, onSelect, format }) {
      const height = 176
      const padLeft = 6
      const padRight = 8
      const padTop = 18
      const padBottom = 22
      const innerWidth = Math.max(24, width - padLeft - padRight)
      const innerHeight = height - padTop - padBottom
      const money = metric === 'cny'

      const barValue = (turn) =>
        money
          ? turn.cny
          : (visible.input ? turn.displayInput : 0) + (visible.cacheRead ? turn.cacheRead : 0) + (visible.output ? turn.output : 0)
      const cumValue = (list, index) => list.slice(0, index + 1).reduce((sum, turn) => sum + (money ? turn.cny : turn.total), 0)

      const maxBar = Math.max(money ? 0.000001 : 1, ...turns.map(barValue))
      const cumulative = []
      let running = 0
      for (const turn of turns) {
        running += money ? turn.cny : turn.total
        cumulative.push(running)
      }
      const maxCumulative = Math.max(money ? 0.000001 : 1, running)

      const slot = innerWidth / Math.max(1, turns.length)
      const barWidth = Math.max(3, Math.min(26, slot * 0.5))
      const xAt = (index) => padLeft + slot * (index + 0.5)
      const baseline = padTop + innerHeight
      const yBar = (value) => baseline - (value / maxBar) * innerHeight
      const yCum = (value) => padTop + innerHeight - (value / maxCumulative) * innerHeight * 0.94

      const points = cumulative.map((value, index) => [xAt(index), yCum(value)])
      const linePath = smoothPath(points)
      const areaPath =
        points.length === 0
          ? ''
          : `${linePath} L${points[points.length - 1][0]},${baseline} L${points[0][0]},${baseline} Z`

      const indexAt = (x) => Math.max(0, Math.min(turns.length - 1, Math.round((x - padLeft) / slot - 0.5)))

      const onMove = (event) => {
        if (turns.length === 0) return
        const rect = event.currentTarget.getBoundingClientRect()
        setHover(indexAt(event.clientX - rect.left))
      }

      const grid = [0, 0.5, 1].map((ratio) =>
        h('line', {
          key: `g${ratio}`,
          x1: padLeft,
          x2: padLeft + innerWidth,
          y1: padTop + innerHeight * ratio,
          y2: padTop + innerHeight * ratio,
          className: 'tkc-grid',
        }),
      )

      const scaleLabel = (value) => (money ? `¥${fmtCny(value)}` : format(value))

      const scales = [
        h(
          'text',
          { key: 'smax', x: padLeft, y: padTop - 6, className: 'tkc-axis', textAnchor: 'start' },
          `${money ? '峰值' : '峰值'} ${scaleLabel(maxBar)}${money ? '' : '/轮'}`,
        ),
        h(
          'text',
          { key: 'cmax', x: padLeft + innerWidth, y: padTop - 6, className: 'tkc-axis', textAnchor: 'end' },
          `累计 ${scaleLabel(maxCumulative)}`,
        ),
      ]

      const bars = []
      for (let index = 0; index < turns.length; index += 1) {
        const turn = turns[index]
        const x = xAt(index) - barWidth / 2
        if (money) {
          const value = turn.cny
          if (value > 0) {
            const top = yBar(value)
            const barHeight = Math.max(1.2, baseline - top)
            bars.push(
              h('rect', {
                key: `b${index}`,
                x,
                y: baseline - barHeight,
                width: barWidth,
                height: barHeight,
                rx: Math.min(2.5, barWidth / 2),
                className: `tkc-bar tkc-cost ${turn.open ? 'is-open' : ''} ${
                  selected === index ? 'is-selected' : ''
                } ${selected !== null && selected !== index ? 'is-dimmed' : ''}`,
              }),
            )
          }
          continue
        }
        let cursor = baseline
        const segments = [
          { value: visible.cacheRead ? turn.cacheRead : 0, className: 'tkc-cache' },
          { value: visible.input ? turn.displayInput : 0, className: 'tkc-input' },
          { value: visible.output ? turn.output : 0, className: 'tkc-output' },
        ]
        for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
          const value = segments[segmentIndex].value
          if (!(value > 0)) continue
          const stackValue = ((baseline - cursor) / innerHeight) * maxBar
          const top = yBar(stackValue + value)
          const segmentHeight = Math.max(0.8, cursor - top)
          bars.push(
            h('rect', {
              key: `b${index}-${segmentIndex}`,
              x,
              y: cursor - segmentHeight,
              width: barWidth,
              height: segmentHeight,
              rx: Math.min(2.5, barWidth / 2),
              className: `tkc-bar ${segments[segmentIndex].className} ${turn.open ? 'is-open' : ''} ${
                selected === index ? 'is-selected' : ''
              } ${selected !== null && selected !== index ? 'is-dimmed' : ''}`,
            }),
          )
          cursor -= segmentHeight
        }
      }

      const labelIndexes = new Set([0, turns.length - 1])
      const stride = Math.max(1, Math.ceil(turns.length / 6))
      for (let index = 0; index < turns.length; index += stride) labelIndexes.add(index)

      const labels = [...labelIndexes]
        .filter((index) => index >= 0 && index < turns.length)
        .map((index) =>
          h(
            'text',
            {
              key: `t${index}`,
              x: xAt(index),
              y: height - 6,
              className: 'tkc-axis',
              textAnchor: index === 0 ? 'start' : index === turns.length - 1 ? 'end' : 'middle',
            },
            `#${turns[index].turn || index + 1}`,
          ),
        )

      const showCumulative = visible.cumulative !== false

      const dots = showCumulative
        ? turns.map((turn, index) =>
            h('circle', {
              key: `d${index}`,
              cx: xAt(index),
              cy: yCum(cumulative[index]),
              r: selected === index ? 4.6 : hover === index ? 4.2 : 2.6,
              className: `tkc-node ${selected === index ? 'is-selected' : ''} ${turn.open ? 'is-open' : ''}`,
            }),
          )
        : null

      const hitAreas = turns.map((turn, index) =>
        h('rect', {
          key: `h${index}`,
          x: xAt(index) - slot / 2,
          y: padTop - 8,
          width: slot,
          height: innerHeight + 8,
          className: 'tkc-hit',
          onClick: () => onSelect(index),
        }),
      )

      const hovered = hover !== null && hover >= 0 && hover < turns.length ? turns[hover] : null

      return h(
        'div',
        { className: 'tkc-chart', style: { height } },
        h(
          'svg',
          {
            width,
            height,
            viewBox: `0 0 ${width} ${height}`,
            className: 'tkc-svg',
            onPointerMove: onMove,
            onPointerLeave: () => setHover(null),
          },
          h(
            'defs',
            null,
            h(
              'linearGradient',
              { id: 'tkc-cum-fill', x1: '0', y1: '0', x2: '0', y2: '1' },
              h('stop', { offset: '0%', className: 'tkc-grad-top' }),
              h('stop', { offset: '100%', className: 'tkc-grad-bottom' }),
            ),
            h(
              'linearGradient',
              { id: 'tkc-cost-fill', x1: '0', y1: '0', x2: '0', y2: '1' },
              h('stop', { offset: '0%', className: 'tkc-cost-top' }),
              h('stop', { offset: '100%', className: 'tkc-cost-bottom' }),
            ),
          ),
          ...grid,
          ...scales,
          ...bars,
          showCumulative && areaPath !== '' ? h('path', { d: areaPath, className: 'tkc-area' }) : null,
          showCumulative && linePath !== '' ? h('path', { d: linePath, className: 'tkc-line' }) : null,
          dots,
          selected !== null
            ? h('line', {
                x1: xAt(selected),
                x2: xAt(selected),
                y1: padTop - 8,
                y2: baseline,
                className: 'tkc-guide is-selected',
              })
            : null,
          ...hitAreas,
          ...labels,
        ),
        hovered !== null && hover !== selected
          ? h(
              'div',
              {
                className: 'tkc-tip',
                style: { left: Math.min(Math.max(xAt(hover), 74), Math.max(width - 74, 74)), top: 2 },
              },
              h('div', { className: 'tkc-tip-head' }, `第 ${hovered.turn || hover + 1} 轮${hovered.open ? ' · 进行中' : ''}`),
              h('div', { className: 'tkc-tip-row' }, h('span', null, '合计'), h('b', null, format(hovered.total))),
              h('div', { className: 'tkc-tip-row' }, h('span', null, '费用'), h('b', null, `¥${fmtCny(hovered.cny)}`)),
              h(
                'div',
                { className: 'tkc-tip-grid' },
                h('span', null, `输入 ${format(hovered.input)}`),
                h('span', null, `缓存 ${format(hovered.cacheRead)}`),
                h('span', null, `输出 ${format(hovered.output)}`),
              ),
              h(
                'div',
                { className: 'tkc-tip-cum' },
                `累计 ${money ? '¥' + fmtCny(cumulative[hover]) : format(cumulative[hover])}`,
              ),
            )
          : null,
      )
    }

    // ---------- 单轮明细 ----------
    function TurnDetail({ turn, cumulativeTokens, cumulativeCny, metric, format }) {
      const rows = [
        { key: 'input', label: '未缓存输入', value: turn.input, className: 'tkc-input' },
        { key: 'cacheWrite', label: '写缓存', value: turn.cacheWrite, className: 'tkc-cachewrite' },
        { key: 'cacheRead', label: '缓存读', value: turn.cacheRead, className: 'tkc-cache' },
        { key: 'output', label: '输出', value: turn.output, className: 'tkc-output' },
      ]
      const maxValue = Math.max(1, ...rows.map((row) => row.value))

      return h(
        'div',
        { className: 'tkc-detail' },
        h(
          'div',
          { className: 'tkc-detail-head' },
          h(
            'div',
            { className: 'tkc-detail-title' },
            `第 ${turn.turn || 1} 轮`,
            turn.open ? h('span', { className: 'tkc-badge' }, '进行中') : null,
          ),
          h(
            'div',
            { className: 'tkc-detail-total' },
            h('b', null, format(turn.total)),
            h('span', null, 'tokens'),
            h('i', { className: 'tkc-detail-sep' }, '·'),
            h('b', { className: 'tkc-detail-cny' }, `¥${fmtCny(turn.cny)}`),
          ),
        ),
        h(
          'div',
          { className: 'tkc-detail-meta' },
          h('span', null, `${turn.messages} 次模型调用`),
          h('span', { className: 'tkc-dot-sep' }, '·'),
          h('span', null, `缓存命中 ${pct(turn.cacheRead, turn.promptSide)}`),
          h('span', { className: 'tkc-dot-sep' }, '·'),
          h('span', null, `精确 ${fmtExact(turn.total)}`),
          turn.startTime > 0 ? h('span', { className: 'tkc-dot-sep' }, '·') : null,
          turn.startTime > 0
            ? h('span', null, `${clockOf(turn.startTime)}${turn.endTime > 0 ? '–' + clockOf(turn.endTime) : ''}`)
            : null,
        ),
        h(
          'div',
          { className: 'tkc-detail-rows' },
          ...rows.map((row) =>
            h(
              'div',
              { key: row.key, className: 'tkc-detail-row' },
              h('span', { className: 'tkc-detail-label' }, row.label),
              h(
                'span',
                { className: 'tkc-detail-track' },
                h('i', {
                  className: `tkc-detail-fill ${row.className}`,
                  style: { width: `${Math.max(1.5, (row.value / maxValue) * 100)}%` },
                }),
              ),
              h('span', { className: 'tkc-detail-value' }, fmtExact(row.value)),
              h('span', { className: 'tkc-detail-share' }, pct(row.value, turn.total)),
            ),
          ),
        ),
        h(
          'div',
          { className: 'tkc-detail-foot' },
          h('span', null, `提示词侧 ${fmtExact(turn.promptSide)}`),
          h('span', { className: 'tkc-dot-sep' }, '·'),
          h('span', null, `累计到这一轮 ${metric === 'cny' ? '¥' + fmtCny(cumulativeCny) : fmtExact(cumulativeTokens)}`),
          h('span', { className: 'tkc-dot-sep' }, '·'),
          h('span', null, `高峰 ${turn.peakMessages} 条 / 空闲 ${turn.offPeakMessages} 条`),
        ),
      )
    }

    // ---------- 账户余额 ----------
    const fmtMoney = (value) => num(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

    const stampOf = (time) => {
      if (!(time > 0)) return ''
      const date = new Date(time)
      if (Number.isNaN(date.getTime())) return ''
      return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }

    function BalanceChip({ state, onRefresh }) {
      const value = state.data
      const ready = value?.status === 'ready'
      const hasCny = value?.total?.CNY !== undefined && value?.total?.CNY !== null
      const label = ready ? (hasCny ? `¥${fmtMoney(value.total.CNY)}` : `$${fmtMoney(value?.total?.USD)}`) : '—'

      const hints = []
      if (ready) {
        hints.push(`充值钱包 ¥${fmtMoney(value.total?.CNY)}`)
        if (num(value.bonusTotal?.CNY) > 0) hints.push(`赠金 ¥${fmtMoney(value.bonusTotal.CNY)}`)
        hints.push(`更新于 ${clockOf(value.updatedAt)}，每 30 秒自动刷新`)
        hints.push('点一下立刻刷新')
      } else if (value?.status === 'signed-out') {
        hints.push(value.reason || '本机没有登录账号，读不到余额')
      } else if (value?.status === 'failed') {
        hints.push(`查询失败：${value.reason || '账号服务没有返回'}`)
      } else if (value?.status === 'unavailable') {
        hints.push(value.reason || '账号服务还没就绪')
      } else if (state.status === 'loading' || state.status === 'refreshing') {
        hints.push('正在查询账户余额…')
      }
      if (state.error) hints.push(state.error)

      const classes = ['tkc-balance']
      if (!ready) classes.push('is-dim')
      if (value?.status === 'failed' || value?.status === 'signed-out') classes.push('is-failed')
      if (state.status === 'loading' || state.status === 'refreshing') classes.push('is-busy')

      return h(
        'button',
        {
          type: 'button',
          className: classes.join(' '),
          title: hints.join(' · '),
          onClick: () => onRefresh(true),
        },
        h('span', { className: 'tkc-balance-label' }, '余额'),
        h('span', { className: 'tkc-balance-num' }, label),
      )
    }

    // ---------- 账单（按月 / 按周） ----------
    const RANGES = [
      { key: 'all', label: '全部' },
      { key: 'this-month', label: '本月' },
      { key: 'last-month', label: '上月' },
      { key: 'last-3m', label: '近三个月' },
      { key: 'this-year', label: '今年' },
    ]

    function BillView({ state, groupBy, range, onGroupBy, onRange, onExport, exporting, note, format }) {
      const [openKey, setOpenKey] = useState(null)
      const value = state.data
      const totals = value?.totals ?? null
      const periods = Array.isArray(value?.periods) ? value.periods : []
      const details = Array.isArray(value?.details) ? value.details : []
      const pricing = value?.pricing ?? null

      useEffect(() => {
        setOpenKey(null)
      }, [groupBy, range])

      const detailOf = useMemo(() => {
        const map = new Map()
        for (const detail of details) {
          const list = map.get(detail.period)
          if (list === undefined) map.set(detail.period, [detail])
          else list.push(detail)
        }
        return map
      }, [details])

      const head = h(
        'div',
        { className: 'tkc-bill-bar' },
        h(
          'div',
          { className: 'tkc-switch', role: 'tablist', 'aria-label': '汇总口径' },
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              'aria-selected': groupBy === 'month',
              className: `tkc-switch-btn ${groupBy === 'month' ? 'is-on' : ''}`,
              onClick: () => onGroupBy('month'),
            },
            '按月',
          ),
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              'aria-selected': groupBy === 'week',
              className: `tkc-switch-btn ${groupBy === 'week' ? 'is-on' : ''}`,
              onClick: () => onGroupBy('week'),
            },
            '按周',
          ),
        ),
        h(
          'select',
          {
            className: 'tkc-select',
            value: range,
            onChange: (event) => onRange(event.target.value),
            title: '统计区间',
          },
          ...RANGES.map((entry) => h('option', { key: entry.key, value: entry.key }, entry.label)),
        ),
        h(
          'button',
          {
            type: 'button',
            className: `tkc-export ${exporting ? 'is-busy' : ''}`,
            onClick: onExport,
            disabled: exporting || value === null,
            title: '导出当前口径与区间的 Excel（汇总 + 明细 + 按会话）',
          },
          exporting ? '生成中…' : '导出 Excel',
        ),
        note !== '' ? h('span', { className: 'tkc-bill-note' }, note) : null,
      )

      const cards =
        totals === null
          ? null
          : h(
              'div',
              { className: 'tkc-cards' },
              h(
                'div',
                { className: 'tkc-card' },
                h('span', { className: 'tkc-card-label' }, '合计费用'),
                h('span', { className: 'tkc-card-value is-money' }, `¥${fmtCny(totals.cny)}`),
              ),
              h(
                'div',
                { className: 'tkc-card' },
                h('span', { className: 'tkc-card-label' }, 'Tokens'),
                h('span', { className: 'tkc-card-value' }, format(totals.total)),
              ),
              h(
                'div',
                { className: 'tkc-card' },
                h('span', { className: 'tkc-card-label' }, '轮次'),
                h('span', { className: 'tkc-card-value' }, fmtExact(totals.turns)),
              ),
              h(
                'div',
                { className: 'tkc-card' },
                h('span', { className: 'tkc-card-label' }, '会话'),
                h('span', { className: 'tkc-card-value' }, fmtExact(value?.coverage?.withUsage ?? 0)),
              ),
            )

      const list =
        periods.length === 0
          ? h(
              'div',
              { className: 'tkc-empty' },
              h(
                'div',
                { className: 'tkc-empty-title' },
                state.status === 'loading' ? '正在统计全部会话…' : '这个区间没有可统计的轮次',
              ),
              h(
                'div',
                { className: 'tkc-empty-body' },
                state.status === 'loading'
                  ? '第一次统计要把本机所有会话日志读一遍，通常一两秒。'
                  : '换一个区间试试，或者先用几轮对话再回来看。',
              ),
            )
          : h(
              'div',
              { className: 'tkc-bill-list' },
              h(
                'div',
                { className: 'tkc-bill-head' },
                h('span', null, groupBy === 'week' ? '周（周一至周日）' : '月份'),
                h('span', null, '金额'),
                h('span', null, '占比'),
                h('span', null, '轮次'),
              ),
              ...periods.map((period) => {
                const open = openKey === period.key
                const rows = detailOf.get(period.key) ?? []
                const shown = rows.slice(0, 150)
                return h(
                  'div',
                  { key: period.key, className: `tkc-period ${open ? 'is-open' : ''}` },
                  h(
                    'div',
                    {
                      className: 'tkc-bill-row',
                      role: 'button',
                      tabIndex: 0,
                      title: open ? '收起明细' : `展开这一格的 ${period.turns} 轮明细`,
                      onClick: () => setOpenKey(open ? null : period.key),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          setOpenKey(open ? null : period.key)
                        }
                      },
                    },
                    h(
                      'span',
                      { className: 'tkc-period-label' },
                      h('i', { className: `tkc-caret ${open ? 'is-open' : ''}` }),
                      period.label,
                    ),
                    h('span', { className: 'tkc-period-money' }, `¥${fmtCny(period.cny)}`),
                    h('span', { className: 'tkc-period-share' }, pct(period.cny, totals?.cny)),
                    h('span', { className: 'tkc-period-turns' }, `${period.turns}`),
                  ),
                  open
                    ? h(
                        'div',
                        { className: 'tkc-period-detail' },
                        ...shown.map((detail, index) =>
                          h(
                            'div',
                            { key: `${detail.sessionId}:${detail.turn}:${index}`, className: 'tkc-detail-line' },
                            h('span', { className: 'tkc-detail-time' }, stampOf(detail.time)),
                            h(
                              'span',
                              { className: 'tkc-detail-name', title: `${detail.title} · 第 ${detail.turn} 轮 · ${fmtExact(detail.total)} tokens` },
                              detail.depth > 0 ? h('i', { className: 'tkc-detail-tag' }, '子') : null,
                              detail.title,
                            ),
                            h('span', { className: 'tkc-detail-tokens' }, format(detail.total)),
                            h('span', { className: 'tkc-detail-money' }, `¥${fmtCny(detail.cny)}`),
                          ),
                        ),
                        rows.length > shown.length
                          ? h(
                              'div',
                              { className: 'tkc-detail-more' },
                              `还有 ${rows.length - shown.length} 条没铺开，导出的 Excel 里是全的。`,
                            )
                          : null,
                      )
                    : null,
                )
              }),
            )

      return h(
        'div',
        { className: 'tkc-bill' },
        head,
        cards,
        list,
        value === null
          ? null
          : h(
              'div',
              { className: 'tkc-bill-foot' },
              `金额按 ${pricing?.fetchedAt ?? '当前'} 价目重算 · 已扣法定节假日 · 读取 ${value.coverage?.files ?? 0} 个会话日志（失败 ${
                value.coverage?.skipped ?? 0
              } 个）`,
              state.status === 'refreshing' ? h('span', { className: 'tkc-bill-busy' }, '读取中…') : null,
            ),
        state.error !== '' ? h('div', { className: 'tkc-error' }, state.error) : null,
      )
    }

    // ---------- 主面板 ----------
    function TokenPanel({ sessionId }) {
      const [metric, setMetric] = useState('token')
      const [visible, setVisible] = useState({ input: true, cacheRead: true, output: true, cumulative: true })
      const [hover, setHover] = useState(null)
      const [selected, setSelected] = useState(null)
      const [hotkey, setHotkey] = useState(() => readHotkey())
      const [capturing, setCapturing] = useState(false)
      const [syncing, setSyncing] = useState(false)
      // 曲线 / 账单 两页：曲线看这一轮对话，账单看本机全部会话（报销用）。
      const [view, setView] = useState('curve')
      const [groupBy, setGroupBy] = useState('month')
      const [range, setRange] = useState('all')
      const [exporting, setExporting] = useState(false)
      const [exportNote, setExportNote] = useState('')
      // 数字单位：万/亿（默认，国内口径）或 K/M/B（国外口径）。
      const [units, setUnits] = useState(() => readUnits())
      const chartRef = useRef(null)
      const width = useElementWidth(chartRef)
      const { status, data, error, refresh } = useTurns(sessionId)
      const balance = useBalance()
      const ledger = useLedger(groupBy, range, view === 'bill')
      const fmtTokens = useCallback((value) => formatTokenValue(value, units), [units])

      const toggleUnits = () => {
        const next = units === 'zh' ? 'en' : 'zh'
        writeUnits(next)
        setUnits(next)
      }

      // 导出：宿主生成 xlsx（汇总 / 明细 / 按会话三张表），浏览器另存。
      const exportBill = () => {
        if (exporting) return
        setExporting(true)
        setExportNote('')
        fetch(EXPORT_API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ groupBy, range }),
        })
          .then(async (response) => {
            if (!response.ok) {
              let message = `HTTP ${response.status}`
              try {
                const payload = await response.json()
                message = payload?.error?.message ?? message
              } catch (error) {
                // 不是 JSON 就用 HTTP 码
              }
              throw new Error(message)
            }
            const blob = await response.blob()
            const url = URL.createObjectURL(blob)
            const today = new Date()
            const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(
              today.getDate(),
            ).padStart(2, '0')}`
            const anchor = document.createElement('a')
            anchor.href = url
            const rangeLabel = RANGES.find((entry) => entry.key === range)?.label ?? ''
            anchor.download = `Token账单_${groupBy === 'month' ? '按月' : '按周'}_${rangeLabel}_${stamp}.xlsx`
            document.body.appendChild(anchor)
            anchor.click()
            anchor.remove()
            setTimeout(() => URL.revokeObjectURL(url), 15000)
            setExportNote('已生成，去下载里找')
            setTimeout(() => setExportNote(''), 6000)
          })
          .catch((failure) => setExportNote(`导出失败：${failure?.message ?? failure}`))
          .finally(() => setExporting(false))
      }

      // 右上角 ↻ 一次刷三样：本对话、余额（强制）、账单（如果在账单页）。
      const refreshAll = () => {
        refresh()
        balance.refresh(true)
        if (view === 'bill') ledger.refresh()
      }

      // 手动拉一次官方价目：宿主那边会强制绕过 12 小时缓存。
      const syncPricing = () => {
        if (syncing) return
        setSyncing(true)
        fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: 'refreshPricing', args: {} }),
        })
          .then((response) => response.json())
          .then((envelope) => {
            if (envelope?.ok) refresh()
          })
          .catch(() => {})
          .finally(() => setSyncing(false))
      }

      // 改键：点一下小胶囊，按下想要的组合就换上；Esc 取消。
      useEffect(() => {
        if (!capturing) return undefined
        window.__tkcCapturing = true
        const onKey = (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (event.code === 'Escape') {
            setCapturing(false)
            return
          }
          if (!/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4]))$/.test(event.code)) return
          const mods = []
          if (event.ctrlKey) mods.push('ctrl')
          if (event.altKey) mods.push('alt')
          if (event.shiftKey) mods.push('shift')
          if (event.metaKey) mods.push('meta')
          if (mods.length === 0) return
          const spec = { mods, code: event.code }
          writeHotkey(spec)
          setHotkey(spec)
          runtime.shortcut = `已绑定 ${hotkeyLabel(spec)}`
          setCapturing(false)
        }
        window.addEventListener('keydown', onKey, true)
        return () => {
          window.__tkcCapturing = false
          window.removeEventListener('keydown', onKey, true)
        }
      }, [capturing])

      const turns = useMemo(() => {
        const raw = Array.isArray(data?.turns) ? data.turns : []
        return raw.map(bucketsOf)
      }, [data])

      const cumulative = useMemo(() => {
        const list = []
        let runningTokens = 0
        let runningCny = 0
        for (const turn of turns) {
          runningTokens += turn.total
          runningCny += turn.cny
          list.push({ tokens: runningTokens, cny: runningCny })
        }
        return list
      }, [turns])

      const totals = useMemo(() => {
        let input = 0
        let cacheRead = 0
        let cacheWrite = 0
        let output = 0
        let total = 0
        let cny = 0
        for (const turn of turns) {
          input += turn.input
          cacheRead += turn.cacheRead
          cacheWrite += turn.cacheWrite
          output += turn.output
          total += turn.total
          cny += turn.cny
        }
        return { input, cacheRead, cacheWrite, output, total, cny, promptSide: input + cacheRead + cacheWrite }
      }, [turns])

      const selectedTurn = selected !== null && selected < turns.length ? turns[selected] : null
      useEffect(() => {
        if (selected !== null && selected >= turns.length) setSelected(null)
      }, [selected, turns.length])

      const pricing = data?.pricing ?? null
      const priced = pricing?.matched != null && pricing.matched !== undefined
      const toggle = (key) => setVisible((previous) => ({ ...previous, [key]: !previous[key] }))
      const select = (index) => setSelected((previous) => (previous === index ? null : index))

      const header = h(
        'div',
        { className: 'tkc-head' },
        h(
          'div',
          { className: 'tkc-total-row' },
          h(
            'div',
            { className: 'tkc-total' },
            h('span', { className: 'tkc-total-num' }, fmtTokens(totals.total)),
            h('span', { className: 'tkc-total-unit' }, 'tokens'),
          ),
          h(BalanceChip, { state: balance, onRefresh: balance.refresh }),
          priced
            ? h(
                'div',
                { className: 'tkc-money', title: '本对话（当前会话）累计费用' },
                h('span', { className: 'tkc-money-label' }, '本会话'),
                h('span', { className: 'tkc-money-sign' }, '¥'),
                h('span', { className: 'tkc-money-num' }, fmtCny(totals.cny)),
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              className: `tkc-refresh ${status === 'loading' || status === 'refreshing' ? 'is-busy' : ''}`,
              title: '重新读取（对话 / 余额 / 账单）',
              onClick: refreshAll,
            },
            '↻',
          ),
        ),
        h(
          'div',
          { className: 'tkc-sub' },
          h('span', null, '本对话累计'),
          h('span', { className: 'tkc-dot-sep' }, '·'),
          h('span', null, `${turns.length} 轮`),
          h('span', { className: 'tkc-dot-sep' }, '·'),
          h('span', null, `缓存命中 ${pct(totals.cacheRead, totals.promptSide)}`),
          data?.model ? h('span', { className: 'tkc-dot-sep' }, '·') : null,
          data?.model ? h('span', { className: 'tkc-model' }, data.model) : null,
          priced ? null : h('span', { className: 'tkc-warn' }, '未收录该模型价目，费用不计'),
          priced
            ? h(
                'span',
                {
                  className: `tkc-price ${pricing?.mode === 'synced' ? 'is-synced' : ''}`,
                  title: pricing?.mode === 'synced' ? '价目来自官方页实时同步' : '还没同步成功，用的是内置表',
                },
                `价目 ${pricing?.fetchedAt ?? '—'}${pricing?.mode === 'synced' ? '' : '（内置）'}`,
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'tkc-units',
              title: units === 'zh' ? '点一下换成 M/K（国外口径）' : '点一下换成 万/亿（国内口径）',
              onClick: toggleUnits,
            },
            `单位 ${units === 'zh' ? '万/亿' : 'M/K'}`,
          ),
          h(
            'button',
            {
              type: 'button',
              className: `tkc-hotkey ${capturing ? 'is-capturing' : ''}`,
              title: capturing ? '按 Esc 取消' : '点一下，再按你想要的组合键（要带 Ctrl / Alt）',
              onClick: () => setCapturing((value) => !value),
            },
            capturing ? '请按组合键…' : `⌨ ${hotkeyLabel(hotkey)}`,
          ),
        ),
        error !== '' ? h('div', { className: 'tkc-error' }, error) : null,
      )

      const metricSwitch = h(
        'div',
        { className: 'tkc-switch', role: 'tablist' },
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': metric === 'token',
            className: `tkc-switch-btn ${metric === 'token' ? 'is-on' : ''}`,
            onClick: () => setMetric('token'),
          },
          'Token',
        ),
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': metric === 'cny',
            className: `tkc-switch-btn ${metric === 'cny' ? 'is-on' : ''}`,
            onClick: () => setMetric('cny'),
            disabled: !priced,
            title: priced ? '按官方价目换算' : '这个模型没有价目',
          },
          '费用',
        ),
      )

      const series = metric === 'cny' ? CNY_SERIES : TOKEN_SERIES
      const legend = h(
        'div',
        { className: 'tkc-legend' },
        ...series.map((entry) =>
          h(
            'button',
            {
              key: entry.key,
              type: 'button',
              className: `tkc-chip ${visible[entry.key] ? 'is-on' : ''} ${entry.className}`,
              onClick: () => toggle(entry.key),
              title: visible[entry.key] ? `隐藏${entry.label}` : `显示${entry.label}`,
            },
            h('i', { className: 'tkc-swatch' }),
            entry.label,
          ),
        ),
      )

      const empty =
        turns.length === 0
          ? h(
              'div',
              { className: 'tkc-empty' },
              h('div', { className: 'tkc-empty-title' }, status === 'loading' ? '正在读取会话…' : '还没有可读的轮次用量'),
              h(
                'div',
                { className: 'tkc-empty-body' },
                status === 'error' ? '读不到这个会话的日志。下面有原因。' : '一轮结束后这里会自己长出来，每 4 秒刷一次。',
              ),
            )
          : null

      const detail = selectedTurn
        ? h(TurnDetail, {
            turn: selectedTurn,
            cumulativeTokens: cumulative[selected]?.tokens ?? 0,
            cumulativeCny: cumulative[selected]?.cny ?? 0,
            metric,
            format: fmtTokens,
          })
        : null

      const table =
        turns.length > 0
          ? h(
              'div',
              { className: 'tkc-table' },
              h(
                'div',
                { className: 'tkc-table-head' },
                h('span', null, '轮次'),
                h('span', null, '合计'),
                h('span', null, '输入'),
                h('span', null, '缓存'),
                h('span', null, '输出'),
              ),
              h(
                'div',
                { className: 'tkc-table-body' },
                ...[...turns].reverse().map((turn, reverseIndex) => {
                  const index = turns.length - 1 - reverseIndex
                  return h(
                    'div',
                    {
                      key: `${turn.turn}:${index}`,
                      className: `tkc-row ${selected === index ? 'is-selected' : ''}`,
                      onPointerEnter: () => setHover(index),
                      onPointerLeave: () => setHover(null),
                      onClick: () => select(index),
                    },
                    h(
                      'span',
                      { className: 'tkc-row-turn' },
                      `#${turn.turn || index + 1}`,
                      turn.open ? h('i', { className: 'tkc-row-open', title: '进行中' }) : null,
                    ),
                    h(
                      'span',
                      { className: 'tkc-row-total' },
                      h('b', null, fmtTokens(turn.total)),
                      priced ? h('i', null, `¥${fmtCny(turn.cny)}`) : null,
                    ),
                    h('span', null, fmtTokens(turn.input)),
                    h('span', null, fmtTokens(turn.cacheRead)),
                    h('span', null, fmtTokens(turn.output)),
                  )
                }),
              ),
            )
          : null

      const diagnostics = h(
        'details',
        { className: 'tkc-debug' },
        h('summary', null, '诊断'),
        h(
          'div',
          { className: 'tkc-debug-body' },
          h('div', null, `会话：${sessionId ?? '无'}`),
          h('div', null, `状态：${status}`),
          h('div', null, `事件：${data?.eventCount ?? '—'} · 轮次：${data?.turnCount ?? '—'}`),
          h('div', null, `忽略的消息：${data?.ignoredMessages ?? 0} · 无用量：${data?.unknownUsage ?? 0}`),
          h('div', null, `已计价：${data?.pricedMessages ?? 0} · 未计价：${data?.unpricedMessages ?? 0}`),
          h('div', null, `模型：${data?.provider ?? '—'} / ${data?.model ?? '—'}`),
          h('div', null, `价目：${pricing?.matched ?? '未收录'} · ${pricing?.mode === 'synced' ? '官方同步' : '内置表'} · ${pricing?.fetchedAt ?? '—'}`),
          h(
            'div',
            null,
            `价目同步：${
              pricing?.syncError
                ? `失败（${pricing.syncError}），仍用${pricing?.mode === 'synced' ? '上次同步的' : '内置'}表`
                : pricing?.syncedAt
                  ? clockOf(pricing.syncedAt)
                  : '未同步'
            }`,
          ),
          h(
            'button',
            { type: 'button', className: 'tkc-sync', onClick: syncPricing, disabled: syncing },
            syncing ? '同步中…' : '立刻同步价目',
          ),
          h(
            'div',
            null,
            `余额：${balance.data?.status ?? '—'}${
              balance.data?.total?.CNY !== undefined ? ` · ¥${fmtMoney(balance.data.total.CNY)}` : ''
            }${balance.data?.reason ? ` · ${balance.data.reason}` : ''} · 更新 ${clockOf(balance.data?.updatedAt) || '—'}`,
          ),
          h(
            'div',
            null,
            `账单：${ledger.data?.detailCount ?? '—'} 条明细 · ${ledger.data?.coverage?.files ?? '—'} 个会话日志 · ${
              ledger.data?.elapsed ?? '—'
            }ms`,
          ),
          priced
            ? h(
                'div',
                null,
                `单价/百万：命中 ${pricing.rates.hit.off}–${pricing.rates.hit.peak} · 未命中 ${pricing.rates.miss.off}–${pricing.rates.miss.peak} · 输出 ${pricing.rates.out.off}–${pricing.rates.out.peak}`,
              )
            : null,
          h('div', null, `价目来源：${pricing?.source ?? '—'}（${pricing?.fetchedAt ?? '—'}）`),
          h('div', null, `节假日：已收录 ${(data?.holidays?.years ?? []).join(' / ') || '—'}`),
          h('div', null, `单位口径：${units === 'zh' ? '万/亿（国内）' : 'M/K（国外）'} · 点顶部胶囊切换`),
          h('div', null, pricing?.note ?? ''),
          h('div', null, `开关键：${hotkeyLabel(hotkey)}（${runtime.installed ?? '未安装'}）`),
        ),
      )

      const viewSwitch = h(
        'div',
        { className: 'tkc-switch tkc-view-switch', role: 'tablist', 'aria-label': '视图' },
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': view === 'curve',
            className: `tkc-switch-btn ${view === 'curve' ? 'is-on' : ''}`,
            onClick: () => setView('curve'),
          },
          '曲线',
        ),
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': view === 'bill',
            className: `tkc-switch-btn ${view === 'bill' ? 'is-on' : ''}`,
            title: '本机全部会话按月 / 按周汇总，可导出 Excel',
            onClick: () => setView('bill'),
          },
          '账单',
        ),
      )

      return h(
        'div',
        { className: 'tkc-root' },
        header,
        h(
          'div',
          { className: 'tkc-controls' },
          viewSwitch,
          view === 'curve' ? metricSwitch : null,
          view === 'curve' ? legend : null,
        ),
        view === 'bill'
          ? h(BillView, {
              state: ledger,
              groupBy,
              range,
              onGroupBy: (value) => {
                setExportNote('')
                setGroupBy(value)
              },
              onRange: (value) => {
                setExportNote('')
                setRange(value)
              },
              onExport: exportBill,
              exporting,
              note: exportNote,
              format: fmtTokens,
            })
          : h(
              'div',
              { className: 'tkc-canvas', ref: chartRef },
              turns.length > 0 && width > 0
                ? h(TokenChart, {
                    turns,
                    width,
                    metric,
                    visible,
                    hover,
                    setHover,
                    selected,
                    onSelect: select,
                    format: fmtTokens,
                  })
                : null,
              empty,
            ),
        view === 'curve' ? detail : null,
        view === 'curve' ? table : null,
        diagnostics,
      )
    }

    // ---------- 错误兜底 ----------
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        console.error('[dsh-token-curve] 面板渲染失败', error)
      }

      render() {
        if (this.state.error) {
          return h(
            'div',
            { className: 'tkc-root tkc-crash' },
            h('div', { className: 'tkc-empty-title' }, 'Token 曲线渲染失败'),
            h('pre', { className: 'tkc-crash-msg' }, String(this.state.error?.stack || this.state.error)),
          )
        }
        return this.props.children
      }
    }

    // ---------- 图标 ----------
    function CurveIcon({ size = 16 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M4 19V5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', opacity: 0.55 }),
        h('path', { d: 'M4 19h16', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', opacity: 0.55 }),
        h('path', {
          d: 'M6.5 15.5c2.2-1.1 3.1-4.4 4.8-5.4 1.6-.9 2.6 2.2 4 1.3 1.5-.9 1.9-3.9 4.2-5',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function HeaderButton({ nav }) {
      return h(
        'button',
        {
          type: 'button',
          className: 'tkc-iconbtn',
          title: `${TITLE}（开/关）`,
          'aria-label': TITLE,
          onClick: () => {
            // 和热键走同一个开关：开着就关，关着就开。
            const toggled = safe(() => window.__tkcToggle?.(), undefined)
            if (toggled !== true) safe(() => nav.openTab(KIND), undefined)
          },
        },
        h(CurveIcon, { size: 17 }),
      )
    }

    // ---------- 样式（深色） ----------
    const CSS = `
.tkc-root{position:relative;display:flex;flex-direction:column;gap:10px;height:100%;min-height:0;padding:14px 14px 10px;font-size:12px;line-height:1.45;color:#e8eefc;box-sizing:border-box;overflow:auto;
  background:radial-gradient(120% 60% at 0% 0%,rgba(91,157,255,.13),transparent 60%),linear-gradient(180deg,#0c1526 0%,#0a101c 100%)}
.tkc-root *{box-sizing:border-box}
.tkc-head{display:flex;flex-direction:column;gap:3px}
.tkc-total-row{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}
.tkc-total{display:flex;align-items:baseline;gap:6px}
.tkc-total-num{font-size:27px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums;color:#fff}
.tkc-total-unit{font-size:11px;color:rgba(232,238,252,.5);letter-spacing:.04em}
.tkc-money{margin-left:auto;display:flex;align-items:baseline;gap:3px;padding:2px 9px;border-radius:8px;background:rgba(61,220,151,.1);border:1px solid rgba(61,220,151,.28)}
.tkc-money-sign{font-size:11px;color:#3ddc97;opacity:.9}
.tkc-money-num{font-size:16px;font-weight:650;color:#74f0ba;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.tkc-refresh{flex:0 0 auto;width:24px;height:24px;padding:0;border:1px solid rgba(255,255,255,.1);border-radius:7px;background:rgba(255,255,255,.03);color:rgba(232,238,252,.55);cursor:pointer;font-size:12px;line-height:1;transition:color .14s ease,border-color .14s ease}
.tkc-refresh:hover{color:#e8eefc;border-color:rgba(91,157,255,.5)}
.tkc-refresh.is-busy{animation:tkc-spin 1s linear infinite;color:#5b9dff}
@keyframes tkc-spin{to{transform:rotate(360deg)}}
.tkc-sub{display:flex;gap:6px;flex-wrap:wrap;color:rgba(232,238,252,.52);font-size:11px}
.tkc-model{max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(91,157,255,.85)}
.tkc-warn{color:#ffb454;opacity:.9}
.tkc-price{padding:0 6px;border-radius:999px;border:1px solid rgba(255,180,84,.35);color:#ffc978;font-size:9.5px;line-height:1.6}
.tkc-price.is-synced{border-color:rgba(61,220,151,.3);color:rgba(116,240,186,.85)}
.tkc-hotkey{flex:0 0 auto;padding:1px 7px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:rgba(232,238,252,.6);font-size:10px;cursor:pointer;font-variant-numeric:tabular-nums;transition:border-color .16s ease,color .16s ease,background .16s ease}
.tkc-hotkey:hover{color:#e8eefc;border-color:rgba(91,157,255,.5)}
.tkc-hotkey.is-capturing{color:#0a101c;background:#5b9dff;border-color:#5b9dff;font-weight:600}
.tkc-error{font-size:11px;color:#ff6b6b;margin-top:2px}
.tkc-dot-sep{opacity:.4}
.tkc-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tkc-switch{display:inline-flex;padding:2px;border-radius:9px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.07)}
.tkc-switch-btn{border:0;background:transparent;color:rgba(232,238,252,.55);font-size:11px;padding:3px 10px;border-radius:7px;cursor:pointer;transition:background .16s ease,color .16s ease}
.tkc-switch-btn:hover{color:#e8eefc}
.tkc-switch-btn.is-on{background:rgba(91,157,255,.22);color:#dfe9ff;box-shadow:inset 0 0 0 1px rgba(91,157,255,.35)}
.tkc-switch-btn:disabled{opacity:.35;cursor:not-allowed}
.tkc-legend{display:flex;gap:6px;flex-wrap:wrap}
.tkc-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.08);background:transparent;color:#e8eefc;font-size:10.5px;cursor:pointer;opacity:.45;transition:opacity .16s ease,background .16s ease,border-color .16s ease}
.tkc-chip:hover{opacity:.85}
.tkc-chip.is-on{opacity:1;background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.16)}
.tkc-swatch{width:7px;height:7px;border-radius:2px;display:inline-block;background:currentColor}
.tkc-chip.tkc-input .tkc-swatch{background:#5b9dff}
.tkc-chip.tkc-cache .tkc-swatch{background:#35c7e0}
.tkc-chip.tkc-output .tkc-swatch{background:#a78bfa}
.tkc-chip.tkc-cost .tkc-swatch{background:#ffb454}
.tkc-chip.tkc-cum .tkc-swatch{border-radius:50%;background:#3ddc97}
.tkc-canvas{position:relative;min-height:120px}
.tkc-chart{position:relative;width:100%}
.tkc-svg{display:block;overflow:visible;touch-action:manipulation}
.tkc-grid{stroke:rgba(255,255,255,.08);stroke-width:1;shape-rendering:crispEdges}
.tkc-bar{shape-rendering:geometricPrecision;transition:opacity .16s ease}
.tkc-bar.tkc-input{fill:#5b9dff}
.tkc-bar.tkc-cache{fill:#35c7e0}
.tkc-bar.tkc-output{fill:#a78bfa}
.tkc-bar.tkc-cost{fill:url(#tkc-cost-fill)}
.tkc-bar.is-dimmed{opacity:.3}
.tkc-bar.is-selected{opacity:1}
.tkc-bar.is-open{opacity:.85}
.tkc-area{fill:url(#tkc-cum-fill)}
.tkc-grad-top{stop-color:#3ddc97;stop-opacity:.26}
.tkc-grad-bottom{stop-color:#3ddc97;stop-opacity:0}
.tkc-cost-top{stop-color:#ffb454;stop-opacity:.95}
.tkc-cost-bottom{stop-color:#c2732a;stop-opacity:.75}
.tkc-line{fill:none;stroke:#3ddc97;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.tkc-node{fill:#3ddc97;stroke:rgba(10,16,28,.9);stroke-width:1.2;transition:r .12s ease}
.tkc-node.is-open{opacity:.55}
.tkc-node.is-selected{stroke:#fff;stroke-width:1.8;filter:drop-shadow(0 0 5px rgba(61,220,151,.75))}
.tkc-guide{stroke:rgba(255,255,255,.22);stroke-width:1;stroke-dasharray:2 3}
.tkc-guide.is-selected{stroke:rgba(61,220,151,.75);stroke-dasharray:none}
.tkc-hit{fill:transparent;cursor:pointer}
.tkc-axis{fill:rgba(232,238,252,.42);font-size:10px;font-variant-numeric:tabular-nums;pointer-events:none}
.tkc-tip{position:absolute;transform:translateX(-50%);pointer-events:none;padding:6px 9px;border-radius:9px;background:rgba(12,20,36,.97);color:#e8eefc;border:1px solid rgba(255,255,255,.1);box-shadow:0 10px 28px rgba(0,0,0,.5);font-size:10.5px;line-height:1.55;white-space:nowrap;z-index:3}
.tkc-tip-head{font-weight:600;margin-bottom:2px;color:#fff}
.tkc-tip-row{display:flex;justify-content:space-between;gap:12px}
.tkc-tip-row b{color:#74f0ba;font-variant-numeric:tabular-nums}
.tkc-tip-grid{display:flex;gap:8px;color:rgba(232,238,252,.6)}
.tkc-tip-cum{color:rgba(232,238,252,.55);margin-top:2px}
.tkc-detail{position:relative;border-radius:11px;border:1px solid rgba(91,157,255,.32);background:linear-gradient(180deg,rgba(91,157,255,.14),rgba(91,157,255,.05));padding:10px 11px 9px;display:flex;flex-direction:column;gap:6px;box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}
.tkc-detail-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding-right:22px}
.tkc-detail-title{font-weight:650;font-size:12.5px;display:flex;align-items:center;gap:5px;color:#fff}
.tkc-badge{font-size:9.5px;font-weight:500;padding:1px 6px;border-radius:999px;background:rgba(255,180,84,.18);color:#ffc978;border:1px solid rgba(255,180,84,.35)}
.tkc-detail-total{margin-left:auto;display:flex;align-items:baseline;gap:4px}
.tkc-detail-total b{font-size:15px;font-variant-numeric:tabular-nums;color:#fff}
.tkc-detail-total span{font-size:10px;color:rgba(232,238,252,.45)}
.tkc-detail-sep{opacity:.35;font-style:normal}
.tkc-detail-cny{color:#74f0ba!important;font-size:13px!important}
.tkc-close{position:absolute;top:7px;right:8px;width:18px;height:18px;padding:0;border:0;border-radius:6px;background:transparent;color:rgba(232,238,252,.5);cursor:pointer;font-size:14px;line-height:1}
.tkc-close:hover{color:#fff;background:rgba(255,255,255,.1)}
.tkc-detail-meta{display:flex;gap:5px;flex-wrap:wrap;font-size:10.5px;color:rgba(232,238,252,.58);font-variant-numeric:tabular-nums;padding-right:18px}
.tkc-detail-rows{display:flex;flex-direction:column;gap:3px}
.tkc-detail-row{display:grid;grid-template-columns:60px 1fr 56px 40px;align-items:center;gap:6px;font-size:10.5px;font-variant-numeric:tabular-nums}
.tkc-detail-label{color:rgba(232,238,252,.6)}
.tkc-detail-track{height:5px;border-radius:3px;background:rgba(255,255,255,.07);overflow:hidden}
.tkc-detail-fill{display:block;height:100%;border-radius:3px}
.tkc-detail-fill.tkc-input{background:#5b9dff}
.tkc-detail-fill.tkc-cachewrite{background:#8fb6ff}
.tkc-detail-fill.tkc-cache{background:#35c7e0}
.tkc-detail-fill.tkc-output{background:#a78bfa}
.tkc-detail-value{text-align:right;color:#eef3ff}
.tkc-detail-share{text-align:right;color:rgba(232,238,252,.4)}
.tkc-detail-foot{display:flex;gap:5px;flex-wrap:wrap;font-size:10px;color:rgba(232,238,252,.5);font-variant-numeric:tabular-nums}
.tkc-table{display:flex;flex-direction:column;border-radius:10px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.025);overflow:hidden;flex:0 1 auto;min-height:0}
.tkc-table-head,.tkc-row{display:grid;grid-template-columns:44px 1.25fr 1fr 1fr 1fr;gap:4px;padding:6px 10px;font-variant-numeric:tabular-nums}
.tkc-table-head{font-size:10.5px;color:rgba(232,238,252,.45);border-bottom:1px solid rgba(255,255,255,.07)}
.tkc-table-head span:not(:first-child){text-align:right}
.tkc-table-body{overflow:auto;max-height:200px}
.tkc-row{border-top:1px solid rgba(255,255,255,.05);transition:background .12s ease;cursor:pointer;align-items:baseline}
.tkc-row:first-child{border-top:0}
.tkc-row:hover{background:rgba(255,255,255,.05)}
.tkc-row.is-selected{background:rgba(91,157,255,.14)}
.tkc-row span:not(:first-child){text-align:right;color:rgba(232,238,252,.75)}
.tkc-row-turn{color:rgba(232,238,252,.45)!important;display:flex;align-items:center;gap:4px}
.tkc-row-open{width:5px;height:5px;border-radius:50%;background:#ffb454;display:inline-block}
.tkc-row-total{display:flex;flex-direction:column;align-items:flex-end;color:#fff!important}
.tkc-row-total b{font-weight:600}
.tkc-row-total i{font-style:normal;font-size:10px;color:#74f0ba;font-variant-numeric:tabular-nums}
.tkc-empty{padding:16px 4px;display:flex;flex-direction:column;gap:6px}
.tkc-empty-title{font-weight:600;color:rgba(232,238,252,.8)}
.tkc-empty-body{color:rgba(232,238,252,.45);font-size:11px;line-height:1.6}
.tkc-debug{margin-top:auto;font-size:10.5px;color:rgba(232,238,252,.35)}
.tkc-sync{margin-top:4px;align-self:flex-start;padding:2px 8px;border-radius:7px;border:1px solid rgba(91,157,255,.35);background:rgba(91,157,255,.12);color:#9dc0ff;font-size:10px;cursor:pointer}
.tkc-sync:hover{background:rgba(91,157,255,.22);color:#cfe0ff}
.tkc-sync:disabled{opacity:.5;cursor:default}
.tkc-debug summary{cursor:pointer;list-style:none}
.tkc-debug summary::-webkit-details-marker{display:none}
.tkc-debug-body{display:flex;flex-direction:column;gap:1px;padding-top:6px;font-variant-numeric:tabular-nums;word-break:break-all;color:rgba(232,238,252,.42)}
.tkc-crash{gap:8px}
.tkc-crash-msg{white-space:pre-wrap;font-size:10.5px;color:rgba(232,238,252,.7);margin:0;max-height:320px;overflow:auto}
.tkc-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:7px;background:transparent;color:inherit;opacity:.62;cursor:pointer;transition:opacity .14s ease,background .14s ease}
.tkc-iconbtn:hover{opacity:1;background:color-mix(in srgb,currentColor 9%,transparent)}
/* 账户余额：放在「本对话费用」左边，蓝色，与绿色费用区分 */
.tkc-balance{display:inline-flex;align-items:baseline;gap:5px;margin-left:auto;padding:2px 9px;border-radius:8px;border:1px solid rgba(91,157,255,.3);background:rgba(91,157,255,.1);color:#dfe9ff;cursor:pointer;font:inherit;transition:border-color .16s ease,background .16s ease}
.tkc-balance:hover{border-color:rgba(91,157,255,.6);background:rgba(91,157,255,.17)}
.tkc-balance-label{font-size:9.5px;color:rgba(232,238,252,.55);letter-spacing:.04em}
.tkc-balance-num{font-size:14px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.tkc-balance.is-dim{opacity:.55;border-color:rgba(255,255,255,.12);background:rgba(255,255,255,.03);color:rgba(232,238,252,.65)}
.tkc-balance.is-failed{border-color:rgba(255,107,107,.35);background:rgba(255,107,107,.08);color:#ffb3b3}
.tkc-balance.is-busy .tkc-balance-num{animation:tkc-blink 1.4s ease-in-out infinite}
@keyframes tkc-blink{0%,100%{opacity:1}50%{opacity:.45}}
.tkc-money{margin-left:0}
.tkc-money-label{font-size:9.5px;color:rgba(116,240,186,.75);letter-spacing:.04em;margin-right:2px}
.tkc-units{padding:0 7px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:rgba(232,238,252,.6);font-size:9.5px;line-height:1.7;cursor:pointer;font-variant-numeric:tabular-nums;transition:border-color .16s ease,color .16s ease}
.tkc-units:hover{color:#e8eefc;border-color:rgba(91,157,255,.5)}
/* 账单页 */
.tkc-view-switch .tkc-switch-btn{padding:3px 12px}
.tkc-bill{display:flex;flex-direction:column;gap:8px;min-height:0;flex:1 1 auto}
.tkc-bill-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tkc-select{appearance:none;min-width:82px;padding:3px 22px 3px 9px;border-radius:8px;border:1px solid rgba(255,255,255,.1);background-color:rgba(255,255,255,.05);color:#e8eefc;font-size:11px;cursor:pointer;background-image:linear-gradient(45deg,transparent 50%,rgba(232,238,252,.6) 50%),linear-gradient(135deg,rgba(232,238,252,.6) 50%,transparent 50%);background-position:calc(100% - 12px) 50%,calc(100% - 8px) 50%;background-size:4px 4px,4px 4px;background-repeat:no-repeat}
.tkc-select option{background:#0f1a2c;color:#e8eefc}
.tkc-export{padding:3px 10px;border-radius:8px;border:1px solid rgba(61,220,151,.4);background:rgba(61,220,151,.12);color:#74f0ba;font-size:11px;cursor:pointer;white-space:nowrap;transition:background .16s ease,opacity .16s ease}
.tkc-export:hover{background:rgba(61,220,151,.22)}
.tkc-export:disabled{opacity:.5;cursor:default}
.tkc-export.is-busy{animation:tkc-blink 1.2s ease-in-out infinite}
.tkc-bill-note{font-size:10px;color:rgba(116,240,186,.8)}
.tkc-cards{display:grid;grid-template-columns:1.15fr 1fr .8fr .8fr;gap:6px}
.tkc-card{display:flex;flex-direction:column;gap:1px;padding:7px 9px;border-radius:9px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.035)}
.tkc-card-label{font-size:9.5px;color:rgba(232,238,252,.45);letter-spacing:.03em}
.tkc-card-value{font-size:15px;font-weight:650;font-variant-numeric:tabular-nums;color:#fff}
.tkc-card-value.is-money{color:#74f0ba}
.tkc-bill-list{display:flex;flex-direction:column;border-radius:10px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.022);overflow:auto;min-height:0;flex:0 1 auto;max-height:min(420px,52vh)}
.tkc-bill-head,.tkc-bill-row{display:grid;grid-template-columns:1fr 82px 52px 42px;gap:6px;padding:6px 10px;align-items:baseline}
.tkc-bill-head{font-size:10px;color:rgba(232,238,252,.45);border-bottom:1px solid rgba(255,255,255,.07);position:sticky;top:0;background:#0c1526;z-index:1}
.tkc-bill-head span:not(:first-child){text-align:right}
.tkc-bill-row{cursor:pointer;border-top:1px solid rgba(255,255,255,.05);font-variant-numeric:tabular-nums;transition:background .12s ease;outline:none}
.tkc-period:first-of-type .tkc-bill-row{border-top:0}
.tkc-bill-row:hover{background:rgba(255,255,255,.05)}
.tkc-bill-row:focus-visible{background:rgba(91,157,255,.16)}
.tkc-period.is-open>.tkc-bill-row{background:rgba(91,157,255,.13)}
.tkc-period-label{display:flex;align-items:center;gap:5px;color:#eef3ff;font-weight:560}
.tkc-caret{width:0;height:0;border-left:4px solid rgba(232,238,252,.55);border-top:3.5px solid transparent;border-bottom:3.5px solid transparent;transition:transform .14s ease;flex:0 0 auto}
.tkc-caret.is-open{transform:rotate(90deg)}
.tkc-period-money{text-align:right;color:#74f0ba;font-weight:600}
.tkc-period-share{text-align:right;color:rgba(232,238,252,.45);font-size:10.5px}
.tkc-period-turns{text-align:right;color:rgba(232,238,252,.6);font-size:10.5px}
.tkc-period-detail{padding:5px 10px 8px 20px;background:rgba(91,157,255,.06);border-top:1px solid rgba(91,157,255,.14);display:flex;flex-direction:column;gap:3px}
.tkc-detail-line{display:grid;grid-template-columns:74px 1fr 56px 62px;gap:6px;font-size:10.5px;font-variant-numeric:tabular-nums;align-items:baseline}
.tkc-detail-time{color:rgba(232,238,252,.42)}
.tkc-detail-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(232,238,252,.8);display:flex;align-items:center;gap:4px}
.tkc-detail-tag{flex:0 0 auto;font-style:normal;font-size:9px;color:#ffc978;border:1px solid rgba(255,180,84,.35);border-radius:4px;padding:0 3px;line-height:1.4}
.tkc-detail-tokens{text-align:right;color:rgba(232,238,252,.5)}
.tkc-detail-money{text-align:right;color:#74f0ba}
.tkc-detail-more{font-size:10px;color:rgba(232,238,252,.4);padding-top:2px}
.tkc-bill-foot{font-size:10px;color:rgba(232,238,252,.4);line-height:1.6;display:flex;gap:6px;flex-wrap:wrap}
.tkc-bill-busy{color:rgba(91,157,255,.9)}
`

    let styleTag = null
    const injectStyle = () => {
      if (typeof document === 'undefined') return
      if (styleTag && styleTag.isConnected) return
      styleTag = document.createElement('style')
      styleTag.dataset.plugin = 'dsh-token-curve'
      styleTag.dataset.pluginCss = 'dsh-token-curve'
      styleTag.textContent = CSS
      document.head.appendChild(styleTag)
    }

    // ---------- 装配 ----------
    function apply(ctx) {
      injectStyle()

      // 一个开关：现在开着就把这一页关掉，否则开出来。快捷键与会话头按钮都走它。
      const togglePanel = () => {
        const controller = (typeof navRef !== 'undefined' && navRef) || ctx.sidebarRight
        if (!controller) {
          runtime.hint = '没有 sidebarRight'
          return false
        }
        const expanded = safe(() => controller.isExpanded(), false)
        if (expanded) {
          const active = safe(() => controller.active(), undefined)
          if (active && active.kind === KIND) {
            safe(() => controller.close(active.id), undefined)
            runtime.hint = '关掉本页'
            return true
          }
          safe(() => controller.toggleExpanded(), undefined)
          runtime.hint = '收起整列'
          return true
        }
        safe(() => controller.openTab(KIND), undefined)
        runtime.hint = '打开本页'
        return true
      }

      ctx.inject?.(['slots', 'sidebarRightTabs', 'sidebarRight'], (scope) => {
        const slots = scope.slots ?? ctx.slots
        const tabs = scope.sidebarRightTabs ?? ctx.sidebarRightTabs
        const nav = scope.sidebarRight ?? ctx.sidebarRight
        navRef = nav ?? navRef

        const guard = (label, register) => {
          try {
            return register()
          } catch (error) {
            console.error(`[dsh-token-curve] ${label} 注册失败`, error)
            return undefined
          }
        }

        scope.effect(
          () =>
            guard('tab type', () =>
              tabs.register({ id: TYPE_ID, kind: KIND, keepMounted: true, title: () => TITLE }),
            ),
          'dsh-token-curve: tab type',
        )

        scope.effect(
          () =>
            guard('tab body', () =>
              slots.register({ name: 'sidebar.right.pane.tab', key: TYPE_ID }, (props) =>
                h(Boundary, null, h(TokenPanel, { sessionId: props?.sessionId })),
              ),
            ),
          'dsh-token-curve: tab body',
        )

        const titleBody = () => h('span', { className: 'tkc-tabtitle' }, h(CurveIcon, { size: 14 }), TITLE)
        scope.effect(
          () => guard('tab title', () => slots.register({ name: 'sidebar.right.pane.tab.title', key: TYPE_ID }, titleBody)),
          'dsh-token-curve: tab title',
        )
        scope.effect(
          () => guard('tab title (kind)', () => slots.register({ name: 'sidebar.right.pane.tab.title', key: KIND }, titleBody)),
          'dsh-token-curve: tab title (kind)',
        )

        scope.effect(
          () =>
            guard('header entry', () =>
              slots.register({ name: 'conversation.session.header.utilities', id: 'dsh-token-curve-entry', order: 86 }, () =>
                h(HeaderButton, { nav }),
              ),
            ),
          'dsh-token-curve: header entry',
        )
      })

      // 全局热键：整页只装一次；每次按下都现读存着的键，所以改完立刻生效。
      if (typeof window !== 'undefined') {
        window.__tkcToggle = togglePanel
        runtime.installed = window.__tkcHotkey === true ? '热键已存在' : '热键已安装'
        if (!window.__tkcHotkey) {
          window.__tkcHotkey = true
          // 应用自己的键盘拦截层会在 window 的捕获阶段处理快捷键，
          // 有些组合它消费掉之后就不会再往下传。所以 keydown 与 keyup 各挂一条，
          // 谁先活着谁干活；两条都到就用时间戳去重，不会抖成开关两下。
          let lastFire = 0
          const fire = (source) => {
            const now = Date.now()
            if (now - lastFire < 400) return
            lastFire = now
            runtime.fires = (runtime.fires ?? 0) + 1
            runtime.lastKey = source
            safe(() => window.__tkcToggle?.(), undefined)
          }
          const onKey = (event) => {
            if (window.__tkcCapturing) return
            if (event.repeat) return
            const spec = readHotkey()
            if (!hotkeyMatches(event, spec)) return
            runtime.seen = `${event.type}/${event.code}`
            event.preventDefault()
            event.stopPropagation()
            fire(event.type)
          }
          window.addEventListener('keydown', onKey, true)
          window.addEventListener('keyup', onKey, true)
        }
        runtime.shortcut = `已绑定 ${hotkeyLabel(readHotkey())}`
      }
    }

    return { name: 'dsh-token-curve', inject: [], apply }
  },
})
