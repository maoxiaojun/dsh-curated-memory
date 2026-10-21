/**
 * dsh-curated-memory
 *
 * Hermes 风格的「精选记忆」插件：把 MEMORY.md（agent 自省笔记）和
 * USER.md（用户画像）以**冻结快照**注入系统提示，并提供一个 memory 工具
 * 让模型在会话中维护它们。
 *
 * 冻结快照语义：
 *   - 插件加载（DSH 启动）时读取一次两本册子，注入系统提示；
 *   - 会话中 memory 工具的写入**立即落盘**，但**不改当前系统提示**
 *     （保护 prefix cache）；
 *   - 下次 DSH 启动时重新读取，刷新快照。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'curated-memory'

/** 需要系统提示注册表与工具注册表就绪。 */
export const inject = ['systemPrompt', 'tools']

export const Config = Schema.object({
  /** 记忆目录；默认 `$DSH_HOME/memory`（没有 DSH_HOME 时 `~/.dsh/memory`）。 */
  baseDir: Schema.string().default(''),
  /** MEMORY.md（agent 自省笔记）字符上限。 */
  memoryCharLimit: Schema.number().default(2200),
  /** USER.md（用户画像）字符上限。 */
  userCharLimit: Schema.number().default(1375),
  /** 系统提示段落排序值；默认排在内置段落之后。 */
  sectionOrder: Schema.number().default(900),
})

const DELIMITER = '\n§\n'

const TARGETS = {
  memory: { file: 'MEMORY.md', header: 'MEMORY (your personal notes)' },
  user: { file: 'USER.md', header: 'USER PROFILE (who the user is)' },
}

function resolveBaseDir(config) {
  if (config.baseDir) return config.baseDir
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'memory')
}

function targetPath(baseDir, target) {
  return path.join(baseDir, TARGETS[target].file)
}

async function readEntries(baseDir, target) {
  try {
    const raw = await fs.readFile(targetPath(baseDir, target), 'utf8')
    return raw
      .split(DELIMITER)
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

async function writeEntries(baseDir, target, entries) {
  await fs.mkdir(baseDir, { recursive: true })
  await fs.writeFile(targetPath(baseDir, target), entries.join(DELIMITER), 'utf8')
}

function limitFor(config, target) {
  return target === 'user' ? config.userCharLimit : config.memoryCharLimit
}

function renderBlock(target, entries) {
  if (!entries.length) return ''
  return [
    `# ${TARGETS[target].header}`,
    '',
    entries.join(DELIMITER),
    '',
    '（以上是冻结快照，本会话内用 memory 工具写入不会出现在这里；下次启动生效。）',
  ].join('\n')
}

async function handleMemoryAction(args, baseDir, config) {
  const action = String(args.action || '').toLowerCase()
  const target = String(args.target || '').toLowerCase()
  if (!TARGETS[target]) return '错误：target 必须是 memory 或 user。'
  const limit = limitFor(config, target)
  const entries = await readEntries(baseDir, target)

  if (action === 'view') {
    if (!entries.length) return `（${target} 为空）`
    return entries.map((e, i) => `${i + 1}. ${e}`).join('\n\n')
  }

  if (action === 'add') {
    const content = String(args.content || '').trim()
    if (!content) return '错误：add 需要 content。'
    const next = [...entries, content]
    const total = next.join(DELIMITER).length
    if (total > limit) {
      return `错误：超出 ${target} 上限（${total}/${limit} 字符）。先用 replace/remove 精简至少 ${total - limit} 字符，或把细节移出记忆。`
    }
    await writeEntries(baseDir, target, next)
    return `已写入 ${TARGETS[target].file}（${total}/${limit} 字符）。注意：冻结快照，本会话系统提示不变，下次 DSH 启动生效。`
  }

  if (action === 'replace' || action === 'remove') {
    const tag = String(args.old || '').trim()
    if (!tag) return `错误：${action} 需要 old（目标条目的唯一短子串）。`
    const matches = entries
      .map((entry, index) => ({ entry, index }))
      .filter((x) => x.entry.includes(tag))
    if (!matches.length) return `错误：没有找到包含 "${tag}" 的条目。`
    if (matches.length > 1) {
      return `错误："${tag}" 匹配到 ${matches.length} 条，请给更长的唯一子串。`
    }
    if (action === 'remove') {
      const next = entries.filter((_, i) => i !== matches[0].index)
      await writeEntries(baseDir, target, next)
      return `已删除一条（${next.join(DELIMITER).length}/${limit} 字符）。下次启动生效。`
    }
    const content = String(args.content || '').trim()
    if (!content) return '错误：replace 需要 content。'
    const next = entries.slice()
    next[matches[0].index] = content
    const total = next.join(DELIMITER).length
    if (total > limit) return `错误：超出 ${target} 上限（${total}/${limit} 字符）。`
    await writeEntries(baseDir, target, next)
    return `已替换一条（${total}/${limit} 字符）。下次启动生效。`
  }

  return '错误：action 必须是 add / replace / remove / view。'
}

export async function apply(ctx, config) {
  const baseDir = resolveBaseDir(config)

  // 冻结快照：插件加载时读取一次。
  const memoryEntries = await readEntries(baseDir, 'memory')
  const userEntries = await readEntries(baseDir, 'user')

  // 注入系统提示（两个独立段落，静态文本 = 冻结）。
  ctx.systemPrompt.section({
    name: 'curated-memory:memory',
    order: config.sectionOrder,
    text: renderBlock('memory', memoryEntries),
    interpolate: false,
  })
  ctx.systemPrompt.section({
    name: 'curated-memory:user',
    order: config.sectionOrder + 1,
    text: renderBlock('user', userEntries),
    interpolate: false,
  })

  // 模型可调用的记忆维护工具。
  ctx.tools.register(
    defineTool({
      name: 'memory',
      description:
        '维护跨会话的精选记忆。MEMORY 是 agent 自己的笔记（环境事实、项目约定、工具坑），' +
        'USER 是对用户的画像（偏好、沟通风格、期望）。' +
        'action: add 追加条目；replace 用 old（唯一短子串）替换；remove 删除；view 查看。' +
        '写入立即落盘，但系统提示用的是会话开始时的冻结快照，下次启动才刷新。' +
        '上限：MEMORY 2200 字符、USER 1375 字符，满了先精简再写。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: 'add | replace | remove | view',
        },
        target: {
          type: 'string',
          required: true,
          description: 'memory | user',
        },
        content: {
          type: 'string',
          required: false,
          description: '新条目内容（add / replace 时必填）',
        },
        old: {
          type: 'string',
          required: false,
          description: '要替换或删除的条目的唯一短子串（replace / remove 时必填）',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        return handleMemoryAction(args, baseDir, config)
      },
    }),
  )
}
