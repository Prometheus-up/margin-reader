import { useEffect, useState } from 'react'
import { DEFAULT_KEYS, KEY_ACTIONS, comboOf, loadKeys, prettyKey, saveKeys, type KeyAction, type KeyMap } from '../lib/keys'
import api from '../api'

export default function SettingsPanel({ onSaved }: { onSaved: () => void }) {
  const [kind, setKind] = useState('mock')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [temperature, setTemperature] = useState('0.6')
  const [saved, setSaved] = useState(false)
  const [presets, setPresets] = useState<Array<{ id: string; name: string; baseUrl: string; model: string; needKey: boolean }>>([])
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; ms: number; model: string; error?: string } | null>(null)
  const [ocModels, setOcModels] = useState<Array<{ id: string; name: string }>>([])
  const [ocCli, setOcCli] = useState('')
  const [cliPath, setCliPath] = useState('')
  const [cleaning, setCleaning] = useState(false)
  const [cleanMsg, setCleanMsg] = useState('')
  const [backing, setBacking] = useState(false)
  const [backupMsg, setBackupMsg] = useState('')
  const [keys, setKeys] = useState<KeyMap>(loadKeys)
  const [capture, setCapture] = useState<KeyAction | null>(null)

  function grab(e: React.KeyboardEvent, id: KeyAction) {
    e.preventDefault()
    e.stopPropagation()
    e.nativeEvent.stopPropagation()
    const next = { ...keys, [id]: comboOf(e.nativeEvent) }
    setKeys(next)
    saveKeys(next)
    setCapture(null)
  }

  async function exportBackup() {
    setBacking(true)
    setBackupMsg('')
    try {
      const r = await api.backup.export()
      setBackupMsg(`已导出到 ${r.path}`)
    } catch (e: any) {
      setBackupMsg(`导出失败：${e?.message ?? String(e)}`)
    } finally {
      setBacking(false)
    }
  }

  useEffect(() => {
    void (async () => {
      setKind(await api.settings.get('ai.kind', 'mock'))
      setBaseUrl(await api.settings.get('ai.baseUrl', 'https://api.deepseek.com/v1'))
      setApiKey(await api.settings.get('ai.apiKey', ''))
      setModel(await api.settings.get('ai.model', 'deepseek-chat'))
      setTemperature(await api.settings.get('ai.temperature', '0.6'))
      setCliPath(await api.settings.get('ai.cliPath', ''))
      try {
        setPresets(await api.ai.presets())
      } catch {
        /* 旧后端没有这个接口时忽略 */
      }
      try {
        const oc = await api.ai.opencode()
        setOcModels(oc.models)
        setOcCli(oc.cli)
        if (oc.models.length > 0) setModel((m) => m || oc.models[0].id)
      } catch {
        /* 忽略 */
      }
    })()
  }, [])

  function applyPreset(id: string) {
    const p = presets.find((x) => x.id === id)
    if (!p) return
    if (p.id === 'mock') {
      setKind('mock')
      return
    }
    if (p.id === 'opencode') {
      setKind('opencode')
      setModel(p.model)
      return
    }
    setKind('openai')
    setBaseUrl(p.baseUrl)
    setModel(p.model)
  }

  async function persist() {
    await api.settings.set('ai.kind', kind)
    await api.settings.set('ai.baseUrl', baseUrl)
    await api.settings.set('ai.apiKey', apiKey)
    await api.settings.set('ai.model', model)
    await api.settings.set('ai.temperature', temperature)
    await api.settings.set('ai.cliPath', cliPath)
  }

  async function save() {
    await persist()
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
    onSaved()
  }

  async function test() {
    setTesting(true)
    setTestResult(null)
    try {
      await persist()
      setTestResult(await api.ai.test())
    } catch (e: any) {
      setTestResult({ ok: false, ms: 0, model, error: e?.message ?? String(e) })
    } finally {
      setTesting(false)
    }
  }

  async function cleanup() {
    setCleaning(true)
    setCleanMsg('')
    try {
      const r = await api.ai.cleanup()
      setCleanMsg(`已清理 ${r.deleted} 条旧会话${r.kept ? `，保留 ${r.kept} 条` : ''}`)
    } catch (e: any) {
      setCleanMsg(`清理失败：${e?.message ?? String(e)}`)
    } finally {
      setCleaning(false)
    }
  }

  return (
    <div className="settings-panel">
      <h3>AI 通道</h3>
      <p className="dim">所有 AI 功能（讨论、出卡片、章节概括）共用这一条通道。支持任意 OpenAI 兼容接口。</p>

      {presets.length > 0 && (
        <label className="field">
          <span>快速选择</span>
          <select value="" onChange={(e) => applyPreset(e.target.value)}>
            <option value="">选择一个预设…</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="field">
        <span>类型</span>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="mock">本地模拟（不联网，用于验证交互）</option>
          <option value="openai">OpenAI 兼容接口</option>
          <option value="opencode">OpenCode 免费模型（走本机 CLI）</option>
        </select>
      </label>

      {kind === 'opencode' && (
        <>
          <label className="field">
            <span>免费模型</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {ocModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>CLI 路径</span>
            <input value={cliPath} onChange={(e) => setCliPath(e.target.value)} placeholder={ocCli || 'D:\\OpenCode\\app\\resources\\opencode-cli.exe'} />
          </label>
          <p className="dim small">
            借用本机已登录的 OpenCode 免费额度：每次调用起一个 CLI 子进程，所以会慢一些（2–5 秒/次）。会话长期保留、不会自动删除——讨论与学习共用「页边 · 讨论与学习」，翻译共用「页边 · 翻译流水线」，它们会跟着你一起积累上下文。
          </p>
          <div className="settings-actions">
            <button className="text-btn" onClick={() => void cleanup()} disabled={cleaning}>
              {cleaning ? '清理中……' : '清理历史会话'}
            </button>
            {cleanMsg && <span className="dim small">{cleanMsg}</span>}
          </div>
        </> 
      )}

      {kind === 'openai' && (
        <>
          <label className="field">
            <span>Base URL</span>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1" />
          </label>
          <label className="field">
            <span>API Key</span>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." />
          </label>
          <label className="field">
            <span>模型</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" />
          </label>
          <label className="field">
            <span>温度</span>
            <input value={temperature} onChange={(e) => setTemperature(e.target.value)} />
          </label>
        </>
      )}

      <div className="settings-actions">
        <button className="primary-btn" onClick={() => void save()}>
          {saved ? '已保存' : '保存'}
        </button>
        <button className="ce-btn" onClick={() => void test()} disabled={testing}>
          {testing ? '测试中…' : '测试连接'}
        </button>
        <button className="ce-btn" onClick={() => void exportBackup()} disabled={backing}>
          {backing ? '导出中…' : '导出数据备份'}
        </button>
      </div>

      {backupMsg && <div className="dim small">{backupMsg}</div>}

      {testResult && (
        <div className={`test-result ${testResult.ok ? 'ok' : 'bad'}`}>
          {testResult.ok ? `连通正常 · ${testResult.ms} ms · ${testResult.model}` : `失败：${testResult.error}`}
        </div>
      )}

      <hr />
      <h3>快捷键</h3>
      <p className="dim small">点一下键位，再按下你想用的组合键。只在没有输入文字时生效。</p>
      <div className="key-list">
        {KEY_ACTIONS.map((a) => (
          <div key={a.id} className="key-row">
            <span className="key-label">{a.label}</span>
            <button
              className={`key-cap ${capture === a.id ? 'wait' : ''}`}
              title="点击后按下新的组合键"
              onClick={() => setCapture(a.id)}
              onKeyDown={(e) => grab(e, a.id)}
              onBlur={() => setCapture((c) => (c === a.id ? null : c))}
            >
              {capture === a.id ? '按下按键…' : prettyKey(keys[a.id])}
            </button>
          </div>
        ))}
      </div>
      <div className="settings-actions">
        <button
          className="text-btn"
          onClick={() => {
            const d = { ...DEFAULT_KEYS }
            setKeys(d)
            saveKeys(d)
            setCapture(null)
          }}
        >
          恢复默认
        </button>
        {capture && <span className="dim small">正在设置「{KEY_ACTIONS.find((x) => x.id === capture)?.label}」</span>}
      </div>

      <hr />
      <h3>关于边界</h3>
      <p className="dim small">
        书内后文在数据层就被过滤掉了：送入模型的段落，其字符结束位置必须早于划线位置，装配后还有一次断言校验。所以模型不是"被告知别说后面"，而是"根本拿不到后面"。
      </p>
    </div>
  )
}
