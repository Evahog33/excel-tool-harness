import { readdirSync, readFileSync, existsSync } from 'fs'
import { resolve, join } from 'path'

export interface PlaybookMeta {
  id: string
  title: string
  keywords: string[]
  description: string
  content: string
}

export class PlaybookManager {
  private playbooks: PlaybookMeta[] = []
  private playbookDir: string

  constructor(playbookDir?: string) {
    this.playbookDir = playbookDir ?? resolve(process.cwd(), 'templates/playbooks')
    this.reload()
  }

  /**
   * 重新载入所有 Playbook 文件
   */
  reload() {
    this.playbooks = []
    if (!existsSync(this.playbookDir)) return

    const files = readdirSync(this.playbookDir)
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      try {
        const fullPath = join(this.playbookDir, f)
        const raw = readFileSync(fullPath, 'utf-8')
        const parsed = this.parsePlaybookMarkdown(raw)
        if (parsed) {
          this.playbooks.push(parsed)
        }
      } catch {}
    }
  }

  /**
   * 解析包含 YAML Frontmatter 的 Markdown
   */
  private parsePlaybookMarkdown(content: string): PlaybookMeta | null {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
    if (!match) {
      return null
    }

    const frontmatterRaw = match[1]
    const body = match[2].trim()

    const meta: Record<string, any> = {}
    let currentKey = ''

    for (const line of frontmatterRaw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      if (trimmed.startsWith('- ') && currentKey) {
        if (!Array.isArray(meta[currentKey])) {
          meta[currentKey] = []
        }
        meta[currentKey].push(trimmed.slice(2).trim())
        continue
      }

      const colonIdx = trimmed.indexOf(':')
      if (colonIdx > 0) {
        currentKey = trimmed.slice(0, colonIdx).trim()
        const val = trimmed.slice(colonIdx + 1).trim()
        if (val) {
          meta[currentKey] = val
        }
      }
    }

    if (!meta.id || !meta.title) return null

    return {
      id: meta.id,
      title: meta.title,
      keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
      description: meta.description || '',
      content: body,
    }
  }

  /**
   * 根据当前任务输入与挂载文件特征，匹配相关领域的 Playbook
   */
  matchPlaybooks(query: string, filenames: string[] = []): PlaybookMeta[] {
    const textToMatch = `${query} ${filenames.join(' ')}`.toLowerCase()
    const matched: PlaybookMeta[] = []

    for (const pb of this.playbooks) {
      const isMatched = pb.keywords.some((kw) => textToMatch.includes(kw.toLowerCase()))
      if (isMatched) {
        matched.push(pb)
      }
    }

    return matched
  }

  /**
   * 格式化注入到 LLM System Prompt 的 Playbook 知识块
   */
  formatPlaybookPrompt(query: string, filenames: string[] = []): string {
    const matched = this.matchPlaybooks(query, filenames)
    if (matched.length === 0) return ''

    const lines: string[] = []
    lines.push(`## 📚 任务相关领域权威规范与避坑准则 (Playbook Knowledge Base)`)
    lines.push(`检测到当前任务涉及以下关键场景，你编写的 Python 代码及答复必须严格遵照以下领域规范：\n`)

    matched.forEach((pb, idx) => {
      lines.push(`### 规范 ${idx + 1}：${pb.title}`)
      lines.push(pb.content)
      lines.push('\n')
    })

    return lines.join('\n')
  }
}
