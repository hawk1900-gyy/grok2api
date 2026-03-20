
### 一、 标准项目结构 (The Context Container)

所有 Vibe 项目必须包含一个 `.ai` (或 `.vibe`) 目录，这是 AI 的“大脑皮层”。

```text
/my-vibe-project
├── .cursorrules           # [配置] 全局 AI 行为准则 (Prompt System Instruction)
├── .ai/                   # [核心] 上下文控制中心
│   ├── status.md          # [动态] 当前任务状态 (Context Window 锚点)
│   ├── architecture.md    # [静态] 系统核心设计与名词定义
│   ├── memory/            # [存档] 过去的决策记录 (ADR)
│   │   └── 001-why-choose-craftjs.md
│   └── templates/         # [工具] 给 AI 用的代码模版 (Component, Hook)
├── src/                   # [产物] 代码实现
└── ...
```

#### 关键文件详解：

1.  **`.cursorrules` (全局守则)**
    *   **作用**：每次对话自动注入，规定 AI 的角色和红线。
    *   **内容**：
        ```markdown
        Role: Senior Architect & Engineer.
        Rule 1: Always read `.ai/status.md` first to understand current task.
        Rule 2: Never break TypeScript types defined in `core/`.
        Rule 3: Update `.ai/status.md` when a task is completed.
        ```

2.  **`.ai/status.md` (当前任务锚点)**
    *   **作用**：这是你控制 AI 注意力的方向盘。每次开始工作前，你手动修改这个文件。
    *   **内容模版**：
        ```markdown
        # Current Session
        - **Goal**: Implement Drag-and-Drop for Text Node.
        - **Phase**: Implementation
        - **Context**: We have already defined `NodeSpec`. Now mapping it to UI.
        
        # Todo
        - [ ] Create DraggableWrapper component
        - [ ] Connect to `useEditor` store
        ```

---

### 二、 交互流程 (The Vibe Loop)

Vibe 编程不是线性的，而是一个 **“文档 <-> 代码” 的闭环**。请严格遵循 **4 步循环法**：

#### 🔴 Step 1: 意图注入 (Intent Injection)
**不要直接写代码。** 先修改 `.ai/status.md` 或者创建一个新的 Spec 文档。

*   **你的动作**：在 `.ai/status.md` 里写下：“当前任务是增加一个 User Profile 组件，包含头像和昵称。”
*   **给 Cursor 的指令**：
    > "Check `@.ai/status.md`. I've updated the current goal. Please explain how you plan to implement this based on our architecture."

#### 🟡 Step 2: 策略对齐 (Alignment)
让 AI 复述方案，确保它理解了架构约束。

*   **AI 回复**：它会列出计划，比如“我需要在 `types` 里加字段，然后写组件”。
*   **你的动作**：确认它的计划没有偏离《核心思想》。如果有偏差，现在纠正。

#### 🟢 Step 3: 生成与编码 (Execution)
批准执行。使用 Cursor 的 Composer (Cmd+I) 模式。

*   **给 Cursor 的指令**：
    > "Approved. Execute the plan. Remember to keep types strict."

#### 🔵 Step 4: 状态同步 (Sync & Commit)
这是最容易被忽略但最重要的一步。**代码写完了，文档必须更新。**

*   **你的动作**：检查代码是否运行正常。
*   **给 Cursor 的指令**：
    > "Task completed. Please update `@.ai/status.md` to mark the todo as done. Also, if we changed any core logic, summarize it in `@.ai/architecture.md`."

---

### 三、 文档更新规范 (When to Update What)

AI 不会自动维护全局一致性，你需要明确告诉它更新哪里。

| 场景 | 修改了什么 | 需要让 AI 更新哪个文档？ | 指令示例 |
| :--- | :--- | :--- | :--- |
| **新功能开发** | 增加了一个新页面/组件 | `.ai/status.md` (打勾) | "Mark todo as done." |
| **架构变更** | 修改了核心数据结构 (`NodeSpec`) | `.ai/architecture.md` | "Update arch doc to reflect the new Node structure." |
| **重大决策** | 决定换掉某个库 (如从 Redux 换到 Zustand) | `.ai/memory/xxx.md` | "Create an ADR (Record) explaining why we switched." |
| **Bug 修复** | 修复了一个小逻辑 | **不需要更新文档** | (仅提交代码) |

---

### 四、 以后新建项目的“起手式”

每次你新建一个 Vibe 风格的项目，请按以下脚本操作：

1.  **Init**：`mkdir .ai`
2.  **Config**：复制你通用的 `.cursorrules` 进去。
3.  **Context**：
    *   创建 `.ai/architecture.md`（把你的核心思想概括进去）。
    *   创建 `.ai/status.md`（写下第一个 Hello World 任务）。
4.  **Prompt**：
    *   打开 Cursor，输入：*"Read `@.ai` folder. Initialize the project structure based on the architecture doc."*

---

**总结你的新身份**：
你不再是一个“写代码的程序员”，你是一个 **“维护 Context 的产品经理”**。
你的代码库质量，完全取决于你 `.ai/` 文件夹里文档的质量。保持那里清晰、最新，AI 就会写出完美的代码。