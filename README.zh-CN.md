# Token & Cost Meter

[English](README.md) · **简体中文**

一个 Hermes 桌面端插件：在状态栏实时显示当前会话烧掉了多少 token、折算成多少美元、
以及提示词缓存帮你省了多少钱。所有观察到的用量都会折叠进本地的按日账本，
**重启 Hermes 之后数字依然在**。

<img src="image/statusbar-chip.png" alt="状态栏芯片：输入 376.4k、输出 100.8k、$11.08、缓存命中 97%、今日 $11.80" width="520">

点击芯片进入完整账本：今日 / 近 7 天 / 本月 / 全部，按模型拆分，每行带缓存命中率和节省额。

## 为什么需要它

Hermes 网关本身会上报实时 token 计数，但费用这一侧有两个缺口：

- **只有 7 家供应商会上报价格。** `hermes_cli/models_pricing.py` 只为
  `openrouter`、`nous`、`ai-gateway`、`novita`、`deepinfra`、`fireworks`、
  `kilocode` 拉取实时单价。其余的——尤其是 **GitHub Copilot** 这类订阅制 / OAuth
  线路——返回的 `pricing` 是空的，所以直接读取只会显示"价格不可用"。
- **计数器会归零。** 它们存在 agent 进程内存里，退出 Hermes 就清空，
  重启后也没有任何地方从数据库回填。

这个插件把两个缺口都补上：内置一份来自 [models.dev](https://models.dev) 的价格表，
覆盖 Hermes 不计价的那些供应商；再用 `ctx.storage` 账本留住历史。

## 安装

### 从插件目录安装

```bash
hermes plugins install token-cost-meter
```

### 手动安装

把 `desktop/plugin.js` 拷进桌面插件目录：

```bash
mkdir -p ~/.hermes/desktop-plugins/token-cost-meter
cp desktop/plugin.js ~/.hermes/desktop-plugins/token-cost-meter/
```

然后在 Hermes 桌面应用里：**⌘K → Reload desktop plugins**。

不需要在 `config.yaml` 里做任何配置——这是一个纯前端插件。

## 功能

**状态栏芯片** —— 输入/输出 token、本次会话花费、缓存命中率，以及今日累计。悬停查看详情。

**右侧面板** —— 本次会话的 token 明细、当前适用的单价、提示词缓存区块
（命中率、缓存 vs 新增、节省金额），以及今日 / 近 7 天 / 本月的小计。

<img src="image/session-pane.png" alt="会话面板：claude-opus-5 运行于 github-copilot，花费 $11.08，合计 13.83M token，缓存命中率 97%，已节省 $60.08" width="340">

**账本整页** —— 四个时间区间的按模型表格，带总计、整体缓存命中率和累计节省额。

双语：English 与简体中文，跟随应用的语言设置自动切换。

## 费用是怎么算的

单价按以下顺序解析，面板上始终会标明用的是哪一级：

| # | 来源 | 显示为 |
|---|------|--------|
| 1 | 当前供应商的实时目录价 | `按目录价格计算` |
| 2 | 此前实时命中并记住的单价 | `历史价格` |
| 3 | 内置的 models.dev 价格表 | `按 models.dev 单价估算` |
| 4 | 其他供应商同名模型的价格 | ⚠ `借用了 <slug> 的价格` |

第 4 级是刻意保留的兜底，并且**带醒目警告**。多家供应商会列同一个模型 id 但价格不同
（Nous 和 GitHub Copilot 都有 `claude-opus-5`，分别是 $4/$20 和 $5/$25 每百万 token），
所以借来的价格绝不会被冒充成你自己线路的价格。

如果网关自己上报了 `cost_usd`，那个数字永远优先——它是唯一不是估算的值。

### Token 分流计费

Hermes 的 `CanonicalUsage` 定义了 `prompt = input + cache_read + cache_write`，
因此每条流按各自的单价计费，避免重复计数：

- `input` 和 `cache_write` → 按输入价
- `cache_read` → 按缓存价（模型没有缓存价时回落到输入价）
- `output` → 按输出价

### 缓存节省

节省额 = 这些缓存 token 按**完整输入价**本该花的钱，减去按**缓存价**实际花的钱。
缓存写入两种算法下都按输入价计费，属于中性项，因此排除在外。

网关只下发四舍五入后的 `cache_hit_pct`，不发原始缓存 token 数，所以缓存量需要还原：
供应商区分 input 和 prompt 时取 `prompt - input`（精确）；两者相等时用
`prompt × 命中率` 反推（推算）。推算路径会继承网关的整数取整误差，有不到 1% 的偏差。

## 关于账本

网关计数器是按活跃 agent 累计的，重启、`/new`、`/reset` 都会归零。
账本的做法是：对每个 `session::model` 存一份快照，只累加**增量**；
读数变小则判定为新的一轮运行，整体采纳。总计按**本地日历日**（不是 UTC）保存 120 天。

数据入口是 `message.complete` 和 `session.usage` 两个事件，外加每 30 秒扫一次当前聚焦会话作为兜底。

两条需要如实说明的限制：

- **无法回溯。** 只记录插件运行期间观察到的用量，安装之前的会话不在账本里。
- **仅限桌面端。** CLI/TUI 的用量不会进入这个账本。

数据存在插件自己的 `ctx.storage` 命名空间内，不会发送到任何地方。

## 刷新价格表

内置价格是打包时的快照。要从 Hermes 本地已有的 models.dev 目录重新生成：

```bash
python3 scripts/gen-rates.py
```

这会就地重写 `desktop/plugin.js` 里的 `FALLBACK_RATES` 字面量。
（桌面插件加载器禁止相对 import，所以价格表没法单独成一个模块。）
当前覆盖 21 家供应商约 1130 个模型。

## 关于准确性

这些是**估算值**，不是账单数据。目录里的 `$/百万 token` 是标价；
订阅制线路按月固定收费，与这里显示的金额无关。
Copilot 的数字应当理解为"如果按 API 标价计算会花多少"。

## 许可

Apache-2.0
