# Grok Cookies 更新说明

本文档说明如何从 Grok 网页获取登录后的 Cookies（SSO Token），以及如何在 Grok2API 管理后台维护这些 Token。

---

## 一、获取 Grok 登录后的 Cookies

Grok2API 需要 Grok 的 SSO Token 才能调用 Grok 服务。Token 来自 grok.com 登录后的浏览器 Cookie。

### 1.1 登录 Grok

1. 打开 https://grok.com
2. 使用 X（Twitter）账号登录
3. 确认能正常使用 Grok 对话

> 国内访问 grok.com 可能需要代理。

### 1.2 打开开发者工具

1. 按 **F12** 或 **Ctrl+Shift+I**（Mac: **Cmd+Option+I**）
2. 切换到 **Application**（应用程序）标签
3. 左侧展开 **Storage** → **Cookies** → 点击 **https://grok.com**

### 1.3 复制 SSO Token

在 Cookie 列表中查找：

| Cookie 名称 | 说明 |
|-------------|------|
| **sso-rw** | 推荐使用，复制其 Value |
| **sso** | 备选，与 sso-rw 通常相同 |

复制该 Cookie 的 **Value**（值），即一长串 JWT 字符串，这就是 SSO Token。

### 1.4 备选方式：从 Network 获取

1. 打开 grok.com 并登录
2. 按 **F12** → 切换到 **Network**（网络）
3. 在 Grok 中发送一条消息
4. 点击任意请求 → **Headers** → **Request Headers** → 找到 **Cookie**
5. 在 Cookie 中找到 `sso-rw=xxx` 或 `sso=xxx`，其中 `xxx` 即为 Token

---

## 二、登录 Grok2API 管理后台

### 2.1 访问登录页

打开：https://grok2api.hawk-bc-1900.workers.dev/login

### 2.2 输入账号密码

| 项目 | 值 |
|------|-----|
| 账户 | admin |
| 密码 | b01010101 |

点击 **登录**。

### 2.3 进入管理控制台

登录成功后会自动跳转到 **管理控制台**（`/manage`），可进行 Token、API Key、设置等管理。

---

## 三、维护 Cookies（Token 管理）

### 3.1 添加新 Token

1. 在管理后台左侧或顶部进入 **Token 管理** / **Tokens**
2. 点击 **添加 Token** 或 **批量添加**
3. 选择类型：
   - **SSO**：普通账号（Basic，约 80 次/20 小时）
   - **SuperSSO**：Super 账号（需 X Premium）
4. 将步骤一复制的 SSO Token 粘贴到输入框
5. 可一次添加多个 Token（每行一个）
6. 点击 **添加** / **确定**

### 3.2 测试 Token

- 在 Token 列表中，每个 Token 旁有 **测试** 按钮
- 点击可验证 Token 是否有效、查看剩余次数

### 3.3 一键刷新剩余次数

- 点击 **刷新** 或 **一键刷新所有 Token**
- 系统会批量请求 Grok 接口更新每个 Token 的剩余额度
- 刷新过程中可查看实时进度

### 3.4 更新失效 Token

当 Token 显示 **失效** 或 **额度耗尽** 时：

1. 重新打开 grok.com，确认账号仍可正常使用
2. 按 **一、获取 Grok 登录后的 Cookies** 重新获取新的 sso-rw/sso 值
3. 在 Grok2API 中：
   - **方式 A**：删除旧 Token，添加新 Token
   - **方式 B**：若支持编辑，直接替换 Token 值

### 3.5 删除 Token

- 勾选要删除的 Token，点击 **批量删除**
- 或点击单个 Token 的 **删除** 按钮

### 3.6 标签与备注

- **标签**：便于分类（如「主号」「备用」）
- **备注**：记录来源、到期时间等，方便后续维护

---

## 四、维护流程概览

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  1. 登录 grok   │ ──► │ 2. 获取 sso-rw   │ ──► │ 3. 登录 Grok2API    │
│     .com        │     │    Cookie 值     │     │    管理后台         │
└─────────────────┘     └──────────────────┘     └──────────┬──────────┘
                                                             │
                                                             ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  6. API 正常    │ ◄── │ 5. 一键刷新      │ ◄── │ 4. 添加/更新 Token  │
│    调用         │     │    额度           │     │    到 Tokens 列表    │
└─────────────────┘     └──────────────────┘     └─────────────────────┘
```

---

## 五、常见问题

### Q1：Token 多久会过期？

- **额度**：Basic 账号每 20 小时重置约 80 次，无需重新获取
- **登录态**：SSO Token 本身会过期（通常数天到数周），过期后需重新登录 grok.com 获取新 Token

### Q2：可以同时添加多个 Token 吗？

可以。Grok2API 会轮询使用，实现负载均衡，建议添加多个 Token 提高可用性。

### Q3：Token 泄露怎么办？

Token 相当于登录凭证，泄露后他人可占用你的额度。建议：
1. 在 Grok2API 中删除该 Token
2. 在 grok.com 中退出登录或修改密码
3. 重新登录后获取新 Token

### Q4：国内无法访问 grok.com 怎么办？

需使用代理或 VPN 访问 grok.com 才能获取 Token。Grok2API 部署在 Cloudflare 上，调用时一般不需要代理。

---

## 六、相关链接

- Grok2API 登录：https://grok2api.hawk-bc-1900.workers.dev/login
- Grok 官网：https://grok.com
