# dsh-curated-memory

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的「精选记忆」插件。

灵感来自 Hermes 的 `MEMORY.md` + `USER.md` 设计：**模型自己维护两本小册子**，以**冻结快照**注入系统提示，而不是每轮检索一大堆可能过期的档案。

## 它解决什么

DSH 默认只有 `AGENTS.md`（静态规则）和可选的外部记忆检索。缺一层「模型可以主动整理、容量有限、每次会话稳定注入」的记忆。这个插件补上这一层：

- `MEMORY.md` —— agent 对自己的笔记：环境事实、项目约定、工具坑、踩过的雷
- `USER.md` —— 对用户的画像：偏好、沟通风格、期望、工作习惯

## 工作原理

```
DSH 启动
  └─ 插件 apply：读取 MEMORY.md / USER.md
       └─ ctx.systemPrompt.section() 注入系统提示（冻结）

会话中
  └─ 模型调用 memory 工具 → 立即写盘
       └─ 但系统提示不变（保护 prefix cache）

下次 DSH 启动
  └─ 重新读取 → 快照刷新
```

**冻结快照**是关键：记忆一改就重写系统提示会打碎 prefix cache，所以宁可「这一场看不到新写的」，也要保持提示稳定。

## 安装

### 从 GitHub（源码安装）

```sh
dsh plugin --profile <name> add github:<you>/dsh-curated-memory
```

本插件是纯 JavaScript（无构建步骤），git 安装后可直接加载。

### 本地开发

在你的 `~/.dsh/cordis.patch.yml`（或 profile 的 patch）里加：

```yaml
- insert:
    - id: curated-memory
      name: 'file:///absolute/path/to/dsh-curated-memory/index.js'
```

重启 DSH 生效。

## 配置

在 patch 行的 `config` 里覆盖（全部可选）：

```yaml
- insert:
    - id: curated-memory
      name: dsh-curated-memory
      config:
        baseDir: 'D:/my-memory'   # 默认 $DSH_HOME/memory
        memoryCharLimit: 2200     # MEMORY.md 字符上限（默认 2200）
        userCharLimit: 1375       # USER.md 字符上限（默认 1375）
        sectionOrder: 900         # 系统提示段落排序（默认 900）
```

## 工具

模型可调用 `memory` 工具：

| 参数 | 说明 |
|---|---|
| `action` | `add` / `replace` / `remove` / `view` |
| `target` | `memory` / `user` |
| `content` | 新条目内容（`add`、`replace`） |
| `old` | 要替换/删除条目的唯一短子串（`replace`、`remove`） |

条目在文件里用 `§` 分隔，可多行。超出字符上限时工具会拒绝写入并提示先精简。

## 设计取舍

- **字符上限而不是 token**：字符数与模型无关，换模型不用重算预算。
- **冻结快照而不是实时注入**：稳定优先，避免 prefix cache 失效。
- **短子串匹配而不是 ID**：模型不用记 ID，`replace`/`remove` 只给一段唯一文本即可。
- **写盘立即、提示延迟**：工具调用有真实反馈（落盘成功），但提示词保持稳定。

## 局限

- 快照在 **DSH 启动**时刷新；同一进程内不会自动更新。
- 容量有限（2200/1375 字符），适合「精选」不适合「全量档案」；全量归档请搭配外部记忆服务（如 Hindsight）。
- 没有语义检索——它是「随身小本子」，不是「档案室」。

## License

MIT
