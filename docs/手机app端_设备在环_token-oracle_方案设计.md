# 手机 App 端 · 设备在环(Device-in-the-Loop)· Token-Oracle 方案设计

> 版本：v0.1（技术储备草案）
> 状态：预研 / 未实施
> 定位：当 Grok 网页版方案失效时的**备胎**；主力仍为 OAuth 网关。

---

## 目录

- [1. 背景与目标](#1-背景与目标)
- [2. 核心思路：不破解，而是"借真机算"](#2-核心思路不破解而是借真机算)
  - [2.1 与"全破解"路线的对比](#21-与全破解路线的对比)
  - [2.2 与现有 OAuth 网关的同构关系](#22-与现有-oauth-网关的同构关系)
- [3. 背景知识：为什么设备认证是命门](#3-背景知识为什么设备认证是命门)
  - [3.1 Play Integrity / App Attest 是什么](#31-play-integrity--app-attest-是什么)
  - [3.2 真正卡人的是服务端绑定](#32-真正卡人的是服务端绑定)
- [4. 总体架构](#4-总体架构)
  - [4.1 架构示意图](#41-架构示意图)
  - [4.2 组件职责](#42-组件职责)
  - [4.3 请求时序](#43-请求时序)
- [5. 关键设计决策点](#5-关键设计决策点)
  - [5.1 token 绑定粒度（决定产能上限）](#51-token-绑定粒度决定产能上限)
  - [5.2 手机端如何算出并交出 token](#52-手机端如何算出并交出-token)
  - [5.3 产能与配额规划](#53-产能与配额规划)
- [6. 手机端 Agent 接口设计](#6-手机端-agent-接口设计)
- [7. 网关侧改造点](#7-网关侧改造点)
- [8. 侦察 Checklist（真机到手后照做）](#8-侦察-checklist真机到手后照做)
- [9. 实施路线图（分阶段）](#9-实施路线图分阶段)
- [10. 风险与失败模式](#10-风险与失败模式)
- [11. 术语表](#11-术语表)
- [12. 参考资料](#12-参考资料)
- [13. 基础环境与起步清单](#13-基础环境与起步清单)
  - [13.1 关键矛盾：root 与"过认证"打架（必读）](#131-关键矛盾root-与过认证打架必读)
  - [13.2 两套机器策略：侦察机 vs 生产机](#132-两套机器策略侦察机-vs-生产机)
  - [13.3 硬件清单](#133-硬件清单)
  - [13.4 PC 端软件（Windows）](#134-pc-端软件windows)
  - [13.5 手机端配置（侦察机）](#135-手机端配置侦察机)
  - [13.6 最小起步套装 vs 完整套装](#136-最小起步套装-vs-完整套装)
  - [13.7 建议的第一步](#137-建议的第一步)

---

## 1. 背景与目标

当前对 Grok 的可用性方案是**网页版 + OAuth 网关**。这套方案依赖官方认证，最稳定，但存在被上游收紧的风险。为防止"网页版有一天不能用"，需要提前做**移动端技术储备**。

直接"全破解手机 App"的难点在于**设备完整性认证**（Android 的 Play Integrity、iOS 的 App Attest），伪造硬件认证成本高、稳定性差，且 2026 年 Google 轮换硬件认证根后越来越难。

**本方案的目标**：设计一套**不伪造设备认证**、而是**保留真机在环、把"必须真机才能算的东西"交给真机计算**的架构，用最小的逆向代价换取相对稳定的产能。

---

## 2. 核心思路：不破解，而是"借真机算"

不追求"把 App 逻辑全部逆出来在服务器上跑"，而是：

- **能自动化的部分**（组请求、账号管理、批量视频生成、结果回收）全部放在**服务器/网关**上。
- **必须真机才能产生的部分**（设备完整性 token / attestation / 请求签名）交给一台或多台**真手机**按需计算并回传。

真手机是一台**正版、干净、锁 bootloader 的真实设备**，跑正版 App —— 它**天然就能通过 STRONG 级认证，不需要伪造任何东西**。我们只需要解决"如何让它按需算出 token 并交出来"。

### 2.1 与"全破解"路线的对比

| 维度 | 全破解（伪造认证） | 设备在环（本方案） |
|---|---|---|
| 是否对抗 attestation | 是，正面硬刚 TEE | 否，直接绕开战场 |
| 需要伪造硬件认证 | 需要（TrickyStore/keybox） | **不需要**（用真机合法值） |
| 稳定性 | 低，随 Google 根轮换失效 | 高，跟官方生命周期一致 |
| 逆向工作量 | 大（整套鉴权/签名逻辑） | 小（只需"读取/触发"token） |
| 主要瓶颈 | 认证被识破即全线崩 | 手机算 token 的吞吐 |
| 硬件成本 | 低（服务器即可） | 需真机（可能需多台组农场） |

### 2.2 与现有 OAuth 网关的同构关系

思路与现有 OAuth 网关**完全同构**：
- OAuth 网关：把"真实账号授权"这件难事交给真身账号，外层用网关封装批量能力。
- 本方案：把"真机算 token"这件难事交给真手机，外层用网关封装批量能力。

真手机在这里扮演的角色，等价于网关里"账号池"中的一个**"认证 oracle"**。

---

## 3. 背景知识：为什么设备认证是命门

### 3.1 Play Integrity / App Attest 是什么

- **Android · Play Integrity API**：App 调用后，Google Play Services 收集软硬件信号，返回一个由 Google 签名的 JWT（integrity token）。三档裁决：
  - `MEETS_BASIC_INTEGRITY`：正版 Play Services（非模拟器/未篡改传输）。
  - `MEETS_DEVICE_INTEGRITY`：正版认证设备、锁 bootloader、未 root。
  - `MEETS_STRONG_INTEGRITY`：Android 13+ 需硬件背书 + 全分区近期安全补丁。
- **iOS · App Attest**：类似的远程认证，返回不透明签名 token；需砸壳 + 真机，逆向更难。

**真机方案的优势**：正版真机跑正版 App，上述裁决**天然全过**，无需任何伪造。

### 3.2 真正卡人的是服务端绑定

Play Integrity 官方定位只是**"信号"**，不是授权本身。防御方是否难缠，取决于**服务端如何校验 token**：

- 若服务端把 token **绑定到一次性 nonce + 具体请求动作 + 短时效窗口**，则重放/复用被堵死 → 每个请求都得现算一个新 token。
- 若 token 是**会话级 / 长期有效**，则一次算出可复用于大量请求 → 产能高。

> **结论：能否规模化，取决于 token 的"绑定粒度"，这必须先抓包确认（见第 8 节）。**

---

## 4. 总体架构

### 4.1 架构示意图

```
┌─────────────────────────────┐        需要 token 时         ┌──────────────────────────┐
│      批量任务 / 网关服务器      │  ──────────────────────▶   │      真手机（1 ~ N 台）      │
│  · 组请求、管账号              │                            │  · 跑正版 App(或带 hook)   │
│  · 批量视频 / 图像生成          │       token 请求(nonce)     │  · 手机端 Agent 监听         │
│  · 结果回收、重试、限流         │                            │  · 触发/抓取 integrity token │
│  · 只在"卡设备认证"时回调手机    │  ◀──────────────────────   │  · 回传 token                │
└─────────────────────────────┘        返回 token            └──────────────────────────┘
            │                                                            ▲
            ▼                                                            │
    ┌───────────────┐                                          ┌────────────────┐
    │   Grok 上游     │  ◀── 带真机 token 的请求 ──               │  设备管理/健康检查 │
    └───────────────┘                                          └────────────────┘
```

### 4.2 组件职责

| 组件 | 职责 |
|---|---|
| **网关服务器** | 组请求、账号池管理、批量调度、限流/重试、结果回收；在需要设备 token 时向手机 Agent 发起回调 |
| **手机端 Agent** | 常驻真机，接收网关的"取 token"请求，触发 App 生成 / 从 App 流程截获 integrity token，回传 |
| **设备管理** | 多台手机时的健康检查、负载均衡、掉线检测、token 缓存策略 |
| **真机（App）** | 正版环境，负责产生合法的设备认证值 |

### 4.3 请求时序

```
网关          手机 Agent        真机 App           Grok 上游
 │  取token(nonce)  │                │                 │
 │ ───────────────▶ │                │                 │
 │                  │  触发/hook      │                 │
 │                  │ ─────────────▶ │                 │
 │                  │                │ 调 Play Integrity │
 │                  │                │ ───(Google)───▶  │
 │                  │  截获 token     │                 │
 │                  │ ◀───────────── │                 │
 │   返回 token      │                │                 │
 │ ◀─────────────── │                │                 │
 │                                                     │
 │        携带真机 token 发起业务请求                     │
 │ ───────────────────────────────────────────────▶  │
 │        业务结果                                       │
 │ ◀───────────────────────────────────────────────  │
```

---

## 5. 关键设计决策点

### 5.1 token 绑定粒度（决定产能上限）

这是**整个方案最重要的未知数**，直接决定架构形态：

| 情况 | 含义 | 产能影响 | 应对 |
|---|---|---|---|
| 会话级 / 长期有效 | 一次算出可复用 | 高，单机可喂大量请求 | 手机端缓存 token，到期前复用 |
| 每请求绑定 nonce + 短时效 | 每请求现算 | 低，被 minting 速度卡死 | 组**手机农场**堆产能 + token 预生产队列 |

> 在第 8 节侦察确认前，**按最坏情况（每请求绑定）预留设计弹性**。

### 5.2 手机端如何算出并交出 token

这是唯一仍需"逆向"的点，但只是**"读取真机合法值"**，不是"造假"，难度远低于伪造硬件认证。备选方案（按侵入性从低到高）：

1. **被动抓取**：Frida / objection hook App 的 integrity 调用返回点，截获 token 后转发。
2. **主动触发**：hook / 反射调用 App 内触发 minting 的方法，按需生成。
3. **无障碍 / 自建模块**：模拟 App 内操作触发流程（最脆、最不推荐）。

推荐 **1 + 2 组合**：能主动触发就主动触发；否则被动等 App 自身流程产生。

### 5.3 产能与配额规划

- **Play Integrity 配额**：标准接口默认每 App 每天有请求上限（万级），per-request 模式会撞天花板 → 需按账号/项目分摊，或申请提额。
- **单机 minting 速率**：一次 minting 约数秒 → 单机 QPS 很低，高并发必须多机。
- **产能公式（每请求绑定时）**：`可用 QPS ≈ 手机台数 × (1 / 单次 minting 秒数) × 安全系数`。

---

## 6. 手机端 Agent 接口设计

手机端 Agent 对网关暴露一个极简 HTTP/WebSocket 服务（建议内网 / 反向隧道）：

```
POST /token
Request:
{
  "nonce": "<网关传入的一次性随机数，可选>",
  "action": "<业务动作标识，可选>",
  "account_hint": "<指定用哪个 App 账号，可选>"
}

Response(成功):
{
  "ok": true,
  "token": "<integrity/attestation token>",
  "expires_at": 1730000000,        // token 失效时间戳(会话级时有意义)
  "bound_nonce": "<回显绑定的 nonce>",
  "device_id": "<手机标识>"
}

Response(失败):
{
  "ok": false,
  "error_code": "MINT_TIMEOUT | APP_NOT_READY | QUOTA_EXCEEDED | HOOK_LOST",
  "message": "..."
}
```

辅助接口：
```
GET  /health   → 手机存活、App 状态、当前可用性、剩余配额估计
POST /warmup   → 预热(预生产一批 token 放入队列，应对突发并发)
```

---

## 7. 网关侧改造点

在现有 OAuth 网关基础上，最小侵入地加入"设备在环"能力：

1. **新增 `device_token_provider` 模块**：封装"向手机 Agent 取 token"的逻辑（含超时、重试、多机负载均衡）。
2. **请求构造钩子**：在打 Grok 上游前，判断该请求是否需要设备 token；需要则调用 `device_token_provider` 取值填入 header/body。
3. **token 缓存层**：会话级 token 缓存复用；每请求绑定时维护预生产队列。
4. **降级策略**：手机 Agent 不可用时，自动降级回现有 OAuth/网页方案，不阻断主流程。
5. **可观测性**：记录 token 来源(手机 device_id)、minting 耗时、失败率，接入现有 usage 统计。

> 设计原则：**手机在环是"增强项"而非"依赖项"**，任何时候手机掉线都能优雅降级。

---

## 8. 侦察 Checklist（真机到手后照做）

在正式投入前，用一台真机 + 抓包工具完成侦察，**核心目的是确认 token 绑定粒度**：

- [ ] 准备环境：正版真机（锁 bootloader）、[HTTP Toolkit](https://httptoolkit.com) 或 [mitmproxy](https://github.com/mitmproxy/mitmproxy)、[objection](https://github.com/sensepost/objection)。
- [ ] 过 SSL Pinning：`objection --gadget <包名> explore` → `android sslpinning disable`。
- [ ] 抓取一次完整业务请求（如视频生成），定位**哪个 header/字段是设备认证 token**。
- [ ] **关键：判断 token 绑定粒度**
  - [ ] 连续发多个请求，看 token 是否**每次都变**（每请求绑定）还是**复用**（会话级）。
  - [ ] 找请求里是否带 **nonce/challenge**，且 nonce 是否由服务端下发。
  - [ ] 拿一个旧 token **重放**同一请求，看服务端是否拒绝（拒绝=有时效/绑定）。
- [ ] 定位 App 内触发 integrity minting 的调用点（`requestIntegrityToken` / `PlayIntegrity` / App Attest 相关）。
- [ ] 评估 minting 耗时（多次取样求平均），估算单机 QPS。
- [ ] 用 [rekit](https://github.com/b-erdem/rekit) 的 `botwall` / `headerprint` 检查是否还有额外风控指纹（TLS/HTTP2 指纹、设备指纹）。
- [ ] 汇总结论 → 决定是"单机复用"还是"手机农场"，并回填第 5.3 节产能公式。

---

## 9. 实施路线图（分阶段）

| 阶段 | 目标 | 产出 |
|---|---|---|
| **P0 储备** | 工具链跑通 + 方法论 | objection/Frida/rekit 环境；本文档 |
| **P1 侦察** | 确认 token 绑定粒度 | 第 8 节 Checklist 结论报告 |
| **P2 单机 PoC** | 一台手机跑通"取 token → 打上游" | 手机 Agent 原型 + 网关钩子（跑通 1 条链路） |
| **P3 网关集成** | 接入现有网关 + 降级策略 | `device_token_provider` 模块 + 缓存/降级 |
| **P4 产能扩展** | 多机农场 + 负载均衡（仅当每请求绑定时需要） | 设备管理 + 健康检查 + 预生产队列 |

> 每阶段结束做一次"是否值得继续"的判断：若 P1 发现服务端绑定极严且配额极低，可能直接判定"投入产出比不划算"，止步于储备。

---

## 10. 风险与失败模式

| 风险 | 说明 | 缓解 |
|---|---|---|
| token 每请求绑定 + 低配额 | 产能天花板很低 | 手机农场；或放弃规模化，仅做小量兜底 |
| App 升级改动认证逻辑 | hook 失效 | 版本锁定；hook 做成可快速更新的脚本 |
| 上游封设备/账号 | 真机被识别为异常 | 控制单机请求量；行为拟人化；多账号分摊 |
| 手机掉线/发热/重启 | 产能中断 | 健康检查 + 自动降级回 OAuth |
| 合规风险 | 违反上游 ToS | 明确仅作技术储备；实际使用需自行评估合规边界 |
| 硬件成本 | 多机农场成本 | 先算清 P1 产能公式再决定投入规模 |

---

## 11. 术语表

- **Device-in-the-Loop（设备在环）**：把必须真机计算的步骤留在真机上，其余自动化。
- **Token Oracle**：一个"按需产出合法 token"的服务角色（此处即真手机）。
- **Attestation / 设备完整性认证**：设备向服务端证明自身真实、未被篡改的机制。
- **Play Integrity API**：Android 的设备完整性认证服务（SafetyNet 的继任者）。
- **App Attest**：iOS 的设备完整性认证服务。
- **minting**：调用认证接口"铸造/生成"一个 token 的动作。
- **nonce 绑定**：token 与服务端下发的一次性随机数关联，防重放。
- **SSL Pinning**：App 只信任内置证书，阻止代理抓包；需 hook 绕过。

---

## 12. 参考资料

- [OWASP MASTG](https://mas.owasp.org/MASTG/) — 移动端安全测试方法论（过 pinning、抓包、逆向标准条目）
- [sensepost/objection](https://github.com/sensepost/objection) — 运行时移动探索，一键过 SSL pinning
- [Frida](https://frida.re) — 动态插桩核心
- [mitmproxy](https://github.com/mitmproxy/mitmproxy) / [HTTP Toolkit](https://httptoolkit.com) — HTTPS 抓包
- [b-erdem/rekit](https://github.com/b-erdem/rekit) — 移动 API 逆向全流水线工具集
- [xob0t/gpmc](https://github.com/xob0t/gpmc) — 逆向移动 API 做成客户端的"成品"参照
- [ropcat/reversing-unofficial-APIs](https://github.com/ropcat/reversing-unofficial-APIs) — 逆向非官方 API 资源合集
- Play Integrity 绕过现状（仅作原理理解）：HackTricks《Play Integrity Attestation Bypass》、TrickyStore 相关分析

---

## 13. 基础环境与起步清单

本章回答"要继续做，需要准备什么"。**核心提醒：先别急着买一堆设备，环境要分两套、分阶段。**

### 13.1 关键矛盾：root 与"过认证"打架（必读）

这是本方案能否落地的命门：

- 要用 Frida hook App 把 token 抠出来 → 通常**需要 root** → 需要**解锁 bootloader**。
- 但**解锁 bootloader 会让 Play Integrity 的 DEVICE/STRONG 直接挂**（verified boot 被破坏，属硬件层判定；Magisk 隐藏 root 只能骗过 App 层检查，骗不过硬件认证）。
- 想在解锁机上还过 STRONG，就得上 TrickyStore 伪造 keybox → **又回到"全破解"战场**，2026 根轮换后越来越不稳。

因此真正的"设备在环、不破解"要成立，**生产机上抠 token 不能破坏认证状态**。这正是 [第 8 节](#8-侦察-checklist真机到手后照做) 侦察阶段要重点验证的：**在不 root 的正版机上，到底有没有办法把 token 拿出来**（被动抓包截获 / companion app / 无障碍驱动等）。

> 结论：**先用侦察机搞懂原理，别急着买生产机。侦察结论决定生产机方案是否成立。**

### 13.2 两套机器策略：侦察机 vs 生产机

| 角色 | 状态 | 用途 | 坏了要紧吗 |
|---|---|---|---|
| **侦察机** | 可 root、可解锁、可刷机 | 抓包、hook、搞懂 token 怎么算 | 不要紧，随便折腾 |
| **生产机** | 正版、干净、锁 bootloader | 真正"算 token"，必须天然过 STRONG | 要紧，保持原厂 |

### 13.3 硬件清单

| 用途 | 推荐 | 理由 |
|---|---|---|
| 侦察机 | **Google Pixel**（如 Pixel 6/7/8，二手即可） | AOSP 亲儿子，解锁 bootloader、Magisk、Frida 支持最好，资料最多 |
| 生产机 | 一台**正版、系统干净、锁 bootloader** 的常见安卓机 | 天然过 Play Integrity STRONG；侦察通过后再决定买几台 |
| 数据线 | 支持数据传输的 USB 线（非纯充电线） | ADB 连接必需 |

- **安卓版本**：侦察机建议 Android 12~14，主流、Frida/Magisk 适配好。
- **iOS 先不碰**：需越狱 + 砸壳 + macOS，难度和成本远高于安卓；安卓路线跑通再说。

### 13.4 PC 端软件（Windows）

| 软件 | 用途 | 备注 |
|---|---|---|
| **ADB / platform-tools** | 连手机、装 App、调 Frida | Google 官方 platform-tools 解压即用 |
| **USB 驱动** | Windows 识别设备 | Pixel 装 Google USB Driver；其他品牌装对应驱动 |
| **Python 3.x** | 跑工具 | 本机已有 |
| **Frida**（`pip install frida-tools`） | 动态插桩核心 | 配套 frida-server 推到手机 |
| **objection**（`pip install objection`） | 一键过 SSL pinning / 探索 | 封装 Frida |
| **mitmproxy** 或 **HTTP Toolkit** | HTTPS 抓包 | HTTP Toolkit 可一键 ADB 接入，新手友好 |
| **jadx** | 反编译 APK 看鉴权逻辑 | 找 minting 调用点 |
| **scrcpy** | PC 上投屏 + 操控手机 | 批量/自动化操作真机很有用 |
| **rekit**（可选） | 逆向全流水线 | `apktap/certpatch/botwall` 等 |

### 13.5 手机端配置（侦察机）

1. 开发者选项 → 打开 **USB 调试**。
2. 解锁 bootloader（**仅侦察机**）→ 刷 **Magisk** 取得 root。
3. 推 **frida-server** 到手机并运行。
4. 装目标 App + 用 objection/HTTP Toolkit 过 pinning 抓包。

> 生产机**不做**上述 2~4 的破坏性操作，保持原厂状态。

### 13.6 最小起步套装 vs 完整套装

**最小起步（先验证原理，花小钱）**：
- 1 台二手 Pixel（侦察机）+ 数据线
- PC 装：platform-tools(ADB)、Python、Frida、objection、HTTP Toolkit、jadx
- 目标：跑通 [第 8 节](#8-侦察-checklist真机到手后照做) Checklist——"过 pinning → 抓到业务请求 → 定位 token 字段 → 判断绑定粒度"

**完整套装（侦察通过、决定投产后再买）**：
- N 台正版生产机 + USB Hub/供电 + scrcpy 批量操控 + 设备健康监控

### 13.7 建议的第一步

**先买 1 台二手 Pixel 当侦察机**，把 PC 工具链装好，照 [第 8 节](#8-侦察-checklist真机到手后照做) Checklist 抓一次 Grok App 的请求，回答三个决定性问题：

1. 哪个字段是设备认证 token？
2. token 是**每请求绑定**还是**会话级复用**？（决定要不要手机农场）
3. **不 root 的正版机上，能不能把 token 拿出来？**（决定整个方案是否成立）

> 这三个答案出来之前，不要投入买生产机——投入产出比全看这一步。

---

> 免责声明：本文档为**技术储备与可行性预研**，不构成对任何服务条款的规避建议。实际实施前请自行评估法律与合规边界。主力方案仍应为官方授权的 OAuth 网关。
