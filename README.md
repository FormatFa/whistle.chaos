# whistle.chaos

基于 [whistle](https://wproxy.org/) 的混沌测试（故障注入）插件。

对匹配规则的请求，按可配置的比例随机注入故障（延迟、错误码、断连、限速等），用于测试服务/客户端的容错能力、降级逻辑与告警是否生效。

## 安装

``` sh
# 发布后安装
npm i -g whistle.chaos
w2 restart

# 本地开发
cd whistle.chaos
npm i
npm run dev        # tsc -w 编译（另开终端执行 lack watch 挂载到 whistle）
lack watch
```




## 规则语法

```
pattern chaos://<配置>
pattern whistle.chaos://<配置>   # 等价长协议
```

配置支持三种写法，混合使用任选其一：

### 1. JSON（功能最全，注意不能包含空格）

```
example.com/api chaos://{"rate":30,"type":"delay","delay":[1000,3000]}
```

### 2. key=value（简洁）

```
example.com/api chaos://type=error,rate=50,statusCode=500|502|503
```

### 3. 预设名（默认参数）

```
example.com/api chaos://delay
```

### 4. Values 预设（配置复杂时推荐）

先在 whistle 界面 Values 中定义 `chaos-preset`：

``` json
{"rate": 20, "type": "delay:3,error:1", "delay": [500, 2000], "log": true}
```

规则中通过 `{名称}` 引用：

```
example.com/api chaos://{chaos-preset}
```

## 配置项

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `rate` | 故障发生比例，0-100 的百分比 | 100 |
| `type` | 故障类型，见下表；支持权重配比 `"delay:3,error:1"`、数组 `["delay","error"]`、对象 `{"delay":3,"error":1}` | delay |
| `log` | 是否在插件日志（`w2 log`）输出注入记录 | false |
| `header` | 是否添加 `x-whistle-chaos` 响应头标记（便于在 Network 面板确认注入） | true |

### 故障类型

| type | 故障效果 | 专属参数 | 底层 whistle 操作 |
| --- | --- | --- | --- |
| `delay` | 注入延迟（毫秒） | `delay`：固定值 / `[min,max]` 区间随机 / `{"min":..,"max":..}`，默认 1000；`phase`：`req`/`res`/`both` 作用阶段，默认 `res` | `reqDelay://` `resDelay://` |
| `error` | 直接返回错误状态码（不请求服务端） | `statusCode`：固定值或列表随机，默认 500；`body`：自定义响应体（默认 JSON） | `statusCode://` `resBody://` |
| `abort` | 直接断开连接（连接重置） | - | `enable://abort` |
| `fail` | 请求阶段直接失败（不发给服务端） | - | `enable://abortReq` |
| `slow` | 响应限速 | `speed`：kb/s，默认 10 | `resSpeed://` |
| `redirect` | 302 重定向 | `location`：目标地址（必填） | `redirect://` |

## 示例

``` txt
# 30% 请求延迟 1~3 秒
example.com/api chaos://{"rate":30,"type":"delay","delay":[1000,3000]}

# 50% 请求随机返回 500/502/503
example.com/api chaos://type=error,rate=50,statusCode=500|502|503

# 30% 请求按 3:1 权重随机「延迟 2s」或「断连」
example.com/api chaos://{"rate":30,"type":"delay:3,abort:1","delay":2000}

# 10% 请求响应限速 5kb/s
example.com/api chaos://slow,rate=10,speed=5

# 100% 返回 503 + 自定义响应体
example.com/api chaos://{"type":"error","statusCode":503,"body":"service unavailable (chaos)"}

# 20% 延迟注入且发生在请求阶段
example.com/api chaos://{"rate":20,"type":"delay","delay":500,"phase":"req"}

# 15% 重定向到降级页面
example.com/api chaos://{"rate":15,"type":"redirect","location":"https://degrade.example.com"}

# 使用 Values 预设 + 开启注入日志
example.com/api chaos://{chaos-preset}

# 全站接口 5% 故障率（混合延迟/错误/断连）
example.com chaos://{"rate":5,"type":"delay:5,error:3,abort:2","delay":[200,3000],"statusCode":[500,502,503]}
```

## 验证注入是否生效

- 打开 whistle Network 面板，命中注入的请求响应头带 `x-whistle-chaos: <type>-<参数>`（如 `error-503`、`delay-1234ms`、`slow-10kbs`）
- 配置 `"log": true` 后通过 `w2 log` 查看每次注入记录
- 配置解析失败时自动放行请求（fail-open），不影响正常流量

## 实现原理

通过 whistle 插件的 `rulesServer` 钩子实现：每个匹配 `chaos://` 的请求到达时，插件按 `rate` 概率决定是否注入，再按 `type` 权重选出故障类型，动态生成对应的 whistle 规则（`resDelay://`、`statusCode://` 等）返回给 whistle 执行。同一规则的每次请求独立决策，天然支持按比例注入。

## 开发与测试

``` sh
npm i
npx tsc         # 编译到 dist
node test.js    # 单元 + 模拟集成测试（无需 whistle）
```

目录结构：

```
whistle.chaos
  ├─ index.js            # 插件入口，注册 rulesServer
  ├─ src/chaos.ts        # 混沌核心：配置解析、比例控制、权重选择、规则生成
  ├─ src/rulesServer.ts  # whistle rulesServer 钩子
  └─ test.js             # 冒烟测试
```
