# dsh-speak-up

给 agent 一个**可以闭嘴的依据**。群聊里最烦的不是不接话，是每条都接；这个插件把「要不要开口」变成一个能算分的判断，而不是靠模型即兴发挥。

- 零运行时依赖，host 插件。
- 提示词里只放判断准则和当前状态（上次开口多久前、冷却还剩多久）。
- `speak_up_should` 拿真实消息打分；`speak_up_note` 在真的开口后推进冷却。

## 打分规则

| 信号 | 分值 |
| --- | --- |
| 被点名 / 被 @ | `+0.55`（并且**强制开口**） |
| 直接提问（`？`、`吗`、`怎么`、`为什么`…） | `+0.25` |
| 命中关键词（每个，最多 3 个） | `+0.15` / 个 |
| 消息有实质内容（≥ 12 字） | `+0.05` |
| 冷场 ≥ 30 分钟 | `+0.20` |
| 冷场 ≥ 2 小时 | `+0.30` |
| 冷却期内（默认 6 分钟） | `-0.45` |
| 安静时段 | `-0.30` |
| 和上次同一个话题 | `-0.15` |

`score >= threshold`（默认 `0.45`）就开口；分数夹在 `0..1`，所以理由能完整解释结论。

## 安装

```powershell
git clone https://github.com/cron114514/dsh-speak-up "$env:USERPROFILE\.dsh\plugins\dsh-speak-up"
cd "$env:USERPROFILE\.dsh\profiles\desktop"
# package.json：dependencies 加 "dsh-speak-up": "link:../../plugins/dsh-speak-up"
#              dsh.profile.bundles 加 "dsh-speak-up"
pnpm install
# 重启 DeepSeek Harness
```

## 配置

```yaml
- insert:
    - id: speak-up
      name: dsh-speak-up
      config:
        threshold: 0.45
        cooldownMinutes: 6
        quietAfterMinutes: 30
        keywords: ['报错', '部署', '结果']
        quietHours: [[0, 7]]
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后不注册任何东西 |
| `threshold` | `0.45` | 开口的分数线 |
| `cooldownMinutes` | `6` | 开口后的冷却长度 |
| `quietAfterMinutes` | `30` | 多久没开口算「冷场」 |
| `keywords` | `[]` | 撞上就加分的词（大小写不敏感） |
| `quietHours` | `[]` | 安静时段，支持跨午夜，如 `[[23, 7]]` |
| `promptOrder` | `9060` | 提示词排序 |
| `promptMaxChars` | `700` | 注入文本上限 |
| `statePath` | — | 覆盖状态文件位置 |

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `speak_up_should` | `message`、`mention`、`question`、`silenceMinutes` | 结论 + 分数 + 逐条理由 + 冷却状态 |
| `speak_up_note` | `topic`、`spoke=false` | 记录一次开口（或明确表示没开口） |

典型用法：收到消息 → `speak_up_should` 问一次 → 分数够就说话，说完 `speak_up_note`。

## 状态

`<DSH_HOME>/plugin-data/dsh-speak-up/state.json`：

```json
{
  "version": 1,
  "lastSpokeAt": 1761300000000,
  "lastTopicHash": "3a7f21c9",
  "history": [1761300000000],
  "lastDecision": { "at": 1761300000000, "speak": true, "score": 0.72, "reasons": [] }
}
```

## 开发

```powershell
node --test
```

## License

MIT
