# dsh-plugin-usage-meter

DeepSeek Harness 网页插件：**API 用量 / 费用 / 余额仪表**。在输入框下方实时显示 token 用量与按官方刊例价估算的费用，点击展开面板查看缓存分桶、上下文占用、账户余额、今日/累计用量与预算提醒，并把跨会话用量持久化成本地账本。

## 功能

- **实时费用**：输入框下方一个**按钮样式的用量条**（圆角边框 + 悬停反馈 + ▾/▴ 箭头），一眼可辨、点击即展开面板；随流式输出实时刷新（数据来自内置 `tokenUsage` 会话投影，provider 上报的真实用量）。
- **用量分布柱状图**：面板内按「时段 × 模型」堆叠的柱状图，颜色区分模型、同段多模型自动堆叠，悬停看明细。
  - **当日（默认）**：24 小时级柱状图，横轴每 3 小时标注一次；
  - **近 7 天**：每日柱状图，一键切换。
  - 按当前刊例价估算；升级前的历史天只有总量（旧账本无模型维度），升级后的数据才带模型拆分。
- **按模型分布**：面板内汇总各模型的费用与 token 占比（事件级归属，跨会话累计），一眼看出哪个模型花得最多。
- **峰谷计价**：按 DeepSeek 官方 2026-08-17 刊例价（高峰 09:00–12:00、14:00–18:00 北京时间为空闲时段的 2 倍），`deepseek-v4-flash` / `deepseek-v4-pro` 双模型，`deepseek-chat`→flash、`deepseek-reasoner`→pro 别名映射；未定价模型按 flash 估算并标注。
- **双币种**：CNY / USD 官方双币种报价，不做汇率换算（与官方账单口径一致）。
- **账户余额**：查询 DeepSeek 官方余额（`GET /user/balance`），带 60s 缓存与手动刷新（查询带 10s 超时，不会拖慢面板）；API Key 走凭证服务（Web「模型」页写入的 `DEEPSEEK_API_KEY`）。
- **跨会话账本**：宿主监听 `session/event` 增量折叠每个会话的用量与模型，持久化到 `$DSH_HOME/usage-meter/ledger.json`（按天×模型 + 当日按小时×模型 + 累计 + 每会话），面板显示「本次会话 / 今日累计 / 累计」。账本原子写入（tmp + rename，防写坏），自动清理（保留 180 天按天数据、当日小时数据，90 天前的零用量会话条目）。
- **预算提醒**：设置每日预算后，费用越接近预算颜色越醒目（≥80% 黄、超支红）。

## 安装

### 从 npm 安装（推荐）

```sh
dsh plugin --profile web add dsh-plugin-usage-meter
```

装完重启 `dsh web` 即可——插件自带 `dsh.bundle.patch`，`dsh plugin` 会自动把它注册进 profile 的 bundle 层，**无需手动改 `cordis.patch.yml`**。

### 从 GitHub 仓库安装

```sh
git clone https://github.com/fancr-code/dsh-plugin-usage-meter.git
dsh plugin --profile web add ./dsh-plugin-usage-meter
```

同样自动注册（bundle patch），重启 `dsh web` 后刷新页面即可在输入框下方看到用量条。

## 设置

编辑 `$DSH_HOME/settings.yaml`（`usage-meter:` 节，全部可选）：

```yaml
usage-meter:
  currency: USD        # CNY（默认）或 USD
  budget: 50           # 每日预算（按上面币种），0 或省略 = 关闭提醒
  pricing:             # 可选：覆盖某模型单价（人民币 / 1M tokens，美元按 6.82 折算）
    deepseek-v4-flash:
      peak:    { cacheMissInput: 3.0, cacheHitInput: 0.10, output: 9.0 }
      offPeak: { cacheMissInput: 1.5, cacheHitInput: 0.05, output: 4.5 }
```

## 卸载

```sh
dsh plugin --profile web remove dsh-plugin-usage-meter
```

然后重启 `dsh web`。由于插件走 bundle 自注册，卸载时 profile 的 bundle 列表会被自动清理，无需手动编辑 `cordis.patch.yml`（旧版手动注册的安装方式需要删除对应条目）。

## 说明

- 账本从插件安装时开始累计（含安装时已打开会话的历史，通过启动回填），不追溯更早的存档会话。
- 余额查询失败（未配置 Key / 网络）会在面板内静默降级为「—」或「未配置余额 API Key」。

## License

MIT
