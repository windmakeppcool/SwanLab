# 路线 B：基于 SwanLab 本地数据自建后台管理系统 — 开发计划

> 目标：不依赖官方云端与闭源 self-hosted 服务端，基于本仓库（Apache-2.0）的本地数据格式，自建一套"实验数据 + 用户权限 + 管理界面"的后台管理系统。
> 使用方式：每个步骤相互独立、自包含（含背景/参考文件/验收标准/风险），可单独交给任意模型实现。

---

## 0. 背景：本仓库能复用什么、缺什么

| 部分 | 状态 | 说明 |
|---|---|---|
| 数据采集 SDK | ✅ 复用 | `swanlab.init/log` 照常使用，产出本地数据 |
| 本地数据格式 + 读取器 | ✅ 复用 | LevelDB log 格式 + `DataStoreReader` + protobuf Record 定义 |
| 数据解析/回放参考实现 | ✅ 复用 | `sync.py` 的记录分发逻辑可直接照抄 |
| HTTP 服务端 | ❌ 无 | 全仓库无 fastapi/flask/django，需自建 |
| 用户/权限系统 | ❌ 无 | 仅有客户端预检（`swanlab/api/self_hosted.py`），服务端需全新写 |
| Web 前端 | ❌ 无 | swanboard 是独立 beta 包（锁 0.1.10b2），官方 UI 在闭源镜像里 |

**协议注意**：本仓库 Apache-2.0，解析代码可直接复制到自己项目（保留 LICENSE 声明）。

---

## 1. 目标架构

```
训练脚本
   │  swanlab.init/log (offline 模式，无需登录)
   ▼
swanlog/                          ← 本地数据（本仓库产出，只读）
 └── run-<ts>-<run_id>/
      ├── run-<run_id>.swanlab    ← Record protobuf 追加流（核心数据）
      ├── files/swanlab-metadata.json | config.yaml | requirements.txt | conda.yaml
      └── media/                  ← 图片/音频/视频文件
   │
   ▼  [Step 1 解析器] → [Step 2 ETL]
自有数据库（SQLite 起步，可迁 PostgreSQL）
   │
   ▼  [Step 3 FastAPI] ← [Step 4 用户权限]
管理前端（Step 5）+ 增量同步（Step 6）+ 部署（Step 7）
```

**数据源选型**：主路线 = 解析 `run-*.swanlab`（数据最全：指标/日志/媒体/超参/系统信息）。
备选 = `mode=local` 让 SDK 直接写 swanboard SQLite（省去解析，但依赖外部 beta 包 schema，且缺日志/媒体关联）——仅在工期极端紧张时作 Step 2 的替代方案。

---

## 2. 关键事实（每个步骤的模型都需要先读这一节）

### 2.1 本地目录结构
- 日志根目录：默认 `./swanlog`，可用环境变量 `SWANLAB_LOGDIR` 修改（[compat/__init__.py](file:///home/lly25782/SwanLab/swanlab/sdk/internal/settings/compat/__init__.py#L68)）。
- run 目录名：`run-{timestamp}-{run_id}`（[init.py](file:///home/lly25782/SwanLab/swanlab/sdk/cmd/init.py#L488-L501)）。
- run 数据文件：`run-{run_id}.swanlab`（[context/__init__.py](file:///home/lly25782/SwanLab/swanlab/sdk/internal/core_python/context/__init__.py#L147-L164)）。

### 2.2 文件格式
- LevelDB log 分块格式：32KB 块、7 字节记录头（CRC32 + 长度 + 类型）、文件头 `:SWL` + magic `0xE1D6` + **version 2**（[store/__init__.py](file:///home/lly25782/SwanLab/swanlab/sdk/internal/core_python/store/__init__.py#L24-L35)）。
- **文件头版本不向下兼容**（同文件 L9 注释）：version 不匹配时读取器直接抛 `DataStoreError`，需给出明确提示。
- 每条记录 = protobuf `swanlab.record.v1.Record`（[record.proto](file:///home/lly25782/SwanLab/protos/swanlab/record/v1/record.proto)），oneof 类型：`start / finish / column / scalar / media / histogram / log / save`。
  - `StartRecord`：project、workspace、name、description、tags、group、color、id、started_at（[run.proto](file:///home/lly25782/SwanLab/protos/swanlab/run/v1/run.proto)）
  - `FinishRecord`：state（RUNNING/FINISHED/CRASHED/ABORTED）、error、finished_at
  - `num` 字段有特殊约定：start=-1、finish=-2、config=-3、metadata=-4、requirements=-5、conda=-6，普通记录从 1 递增（record.proto L25-L32）——可用于去重与增量判断。

### 2.3 直接可用的读取 API
- `DataStoreReader`：`open(path)` → 迭代 `for record_bytes in reader:`（[store/__init__.py](file:///home/lly25782/SwanLab/swanlab/sdk/internal/core_python/store/__init__.py#L173-L239)）。
- 记录分发参考实现：[sync.py](file:///home/lly25782/SwanLab/swanlab/sdk/internal/core_python/sync.py#L192-L210) 的 `_handle_record`（按 oneof 分发）、`deliver_sync_start`（校验首条必须是 start）。
- 读写示例代码：`tests/benchmark/sdk/internal/core_python/store/bench_store_skip.py`（L295 起）。

### 2.4 已知坑（写进各步骤的实现要求）
1. **写入中的文件尾部不完整**：writer 不做逐条 flush（store/__init__.py L118-127），进程崩溃时尾部数据可能缺失；解析器必须容错，损坏记录应停止迭代而非崩溃（`__next__` 已有此行为）。
2. **正在运行的 run**：没有 FinishRecord 不代表异常，可能是仍在运行。
3. **媒体文件引用**：MediaRecord 中的路径需按 run 目录解析（参考 `ctx.media_dir`，context L119-120）。
4. **不要修改 SwanLab 源码**：只 import 或复制；需要改动时在自己项目内 fork。

---

## 3. 分步骤计划

### Step 0 — 环境与样例数据准备
- **目标**：可复现的本地数据样例，供后续所有步骤测试。
- **动作**：
  1. `make init`（或 `pip install -e .`）装好本仓库；
  2. 写一个离线训练示例脚本：`swanlab.init(mode="offline", project="demo")` + 循环 `swanlab.log`（含 scalar、图片、直方图、打印日志）+ `swanlab.finish()`；
  3. 造三类样例：正常结束、崩溃中断（kill 进程）、超大指标量（≥10 万点）。
- **验收**：`swanlog/` 下有 ≥3 个 run 目录；`run-*.swanlab` 可被 `DataStoreReader` 读通；样例脚本入库（放自己项目，不放本仓库）。
- **难度**：低｜**模型选择**：小模型即可。

### Step 1 — 只读解析器（独立 Python 模块）
- **目标**：把 `run-*.swanlab` 解析为结构化数据（不落库，先出 JSON/统计）。
- **输入**：§2 的格式事实；精读 `store/__init__.py`、`sync.py`、`protos/swanlab/**/*.proto`。
- **产出**：
  1. `parser` 包：`scan_run(path) -> Iterator[Record]`，封装 header 版本校验、损坏容错；
  2. `run_summary(path)`：提取 start（项目/名称/标签）、finish（状态）、列清单、step 范围、日志行数、媒体文件清单；
  3. CLI：`parse <swanlog_dir> --stat / --export-json <out>`。
- **验收**：
  - 对 Step 0 三类样例全部解析成功，字段与 `swanlab` 官方行为一致（可与 `swanlab sync --help` 场景对照）；
  - version 不匹配、文件截断、首条非 start 记录三种异常均给出清晰错误；
  - 单元测试覆盖 oneof 全部 8 种记录类型。
- **风险**：protobuf 依赖版本（本仓库要求 protobuf>=6.31.1）。
- **难度**：中｜**模型选择**：需要大上下文 + 强推理（要精读 store/sync/proto 三处）。

### Step 2 — 数据模型与 ETL
- **目标**：解析结果落入自有数据库，支持后台查询。
- **设计要点**（schema 起步建议）：
  - `project` / `experiment`（run 目录、start/finish 字段、状态、时间）
  - `column`（指标列定义：key、类型、display name）
  - `scalar_point`（experiment_id, column_id, step, value, timestamp）——量大，必须有 `(experiment_id, column_id, step)` 索引
  - `log_line`（experiment_id, epoch, level, line, timestamp）
  - `save_file`（metadata/config/requirements/conda 内容或路径）、`media_file`（路径、类型、关联列）
- **动作**：全量 ETL 脚本 + 增量（用 `num` 特殊约定与文件 mtime 判断）；幂等（重复执行不产生重复行）。
- **验收**：
  - 幂等测试：同一 `swanlog/` 跑两次，行数不变；
  - 10 万点实验的区间查询（`WHERE step BETWEEN ? AND ?`）< 100ms；
  - Step 0 的三类样例状态正确（FINISHED / CRASHED / RUNNING）。
- **难度**：中｜**模型选择**：中等模型 + 明确 schema 规格即可；ETL 幂等与索引设计别省。

### Step 3 — 后端 API（FastAPI）
- **目标**：只读查询 API + 管理接口骨架。
- **端点规划**：
  - `POST /auth/login`、`GET /auth/me`
  - `GET /projects`、`GET /projects/{id}/experiments`（分页/筛选/排序）
  - `GET /experiments/{id}`（summary：start/finish/config/metadata）
  - `GET /experiments/{id}/metrics?keys=&step_range=`（曲线，支持多实验对比）
  - `GET /experiments/{id}/logs?level=&page=`
  - `GET /experiments/{id}/media/{file}`（静态文件受控访问）
  - `GET /experiments/{id}/saves/{type}`（config/metadata 下载）
- **参考**：本仓库 `swanlab/api/` 的实体划分与分页设计（[base.py](file:///home/lly25782/SwanLab/swanlab/api/base.py#L115-L130) 的 `_paginate`、`typings/common.py` 的 `PaginatedQuery`）——**注意它是客户端，只抄接口形状，不抄 HTTP 调用**。
- **验收**：pytest + httpx TestClient 覆盖全部端点；OpenAPI 文档可打开；鉴权中间件先行（Step 4 接入前先用固定 token 占位）。
- **难度**：中｜**模型选择**：常规后端模型，端点多但模式统一。

### Step 4 — 用户与权限系统（RBAC）
- **目标**：真正的"后台管理"能力，本仓库无任何可复用服务端实现，全新写。
- **范围**：
  1. 用户表（username/password hash/role：admin、member）；
  2. 登录签发 JWT（或 session cookie），refresh 策略；
  3. 项目级授权：admin 全量、member 仅被授权项目；
  4. 管理操作：用户增删改、项目归属调整、审计日志（谁在何时做了什么）；
  5. 对 Step 3 全部端点补权限断言。
- **可借鉴（仅语义，非代码）**：`swanlab/api/self_hosted.py` 的 `validate_expire/validate_root` 表达了"实例级 + root 级"两层权限模型，可参考其分层思路设计自己的中间件。
- **验收**：
  - 测试用例：未登录 401、跨项目访问 403、admin 可管理用户；
  - 密码存储使用 bcrypt/argon2，绝不存明文；
  - 审计日志可查询。
- **难度**：中高（安全敏感）｜**模型选择**：安全性强的模型；此步不建议用最便宜的档位。

### Step 5 — 管理前端
- **目标**：可用的管理界面（技术栈自选：React/Vue + ECharts，或服务端渲染模板）。
- **页面清单**：
  1. 登录页；
  2. 项目列表（卡片/表格，实验数、最近更新）；
  3. 实验列表（筛选：状态/标签/作者；排序：时间/指标值；批量对比入口）；
  4. 实验详情：指标曲线（多曲线、缩放、step 区间）、超参表（config.yaml）、系统信息（swanlab-metadata.json）、终端日志（分页/级别过滤）、媒体画廊、保存文件下载；
  5. 多实验对比视图（同 key 叠加）；
  6. 管理页（用户管理，仅 admin）。
- **参考**：官方离线看板仓库 `SwanLab-Dashboard`（GitHub）的 web 代码可作交互与图表参考（外部仓库，注意其协议）。
- **验收**：核心 5 条路径端到端可用（登录→项目→实验→曲线→日志）；10 万点曲线渲染不卡（前端做降采样或后端聚合）。
- **难度**：高（工作量最大）｜**模型选择**：可拆成"图表组件 / 列表页 / 详情页"多个子任务并行，各自交给前端模型。

### Step 6 — 增量同步与"运行中实验"实时可见
- **目标**：训练进行时，后台近实时看到新数据。
- **方案**：
  1. 轮询/watchdog 监控 `swanlog/` 新 run 目录与 `run-*.swanlab` 文件增长（[本地已有 watchdog 依赖](file:///home/lly25782/SwanLab/pyproject.toml#L56)）；
  2. 增量解析：记住每个文件已处理的字节偏移，只追加解析新记录（注意尾部不完整需缓冲）；
  3. 更新 DB 后通过 WebSocket/SSE 推给前端；
  4. 无 FinishRecord 的 run 状态显示为 RUNNING，出现后转 FINISHED/CRASHED。
- **验收**：训练脚本运行期间，5 秒内前端可见新指标点；进程崩溃后状态正确翻转；重复启动增量任务不重复入库。
- **难度**：中高（并发与文件边界处理）｜**模型选择**：强推理模型，重点测边界用例。

### Step 7 — 部署、测试与交付
- **目标**：一键起整套系统 + 回归保障。
- **动作**：
  1. docker compose：backend + db + frontend + 数据卷（挂载 `swanlog/` 只读）；
  2. CI：pytest（parser/ETL/API/权限）+ 前端 lint/build；
  3. 备份策略：DB 定期导出；`swanlog/` 原始数据保留为事实源（可随时重建 DB）；
  4. 运维文档：启动、升级、数据重建命令。
- **验收**：新机器上 `docker compose up` + 指向已有 `swanlog/` 即可看到全部历史实验；DB 删除后可从 `swanlog/` 完整重建。
- **难度**：低中｜**模型选择**：常规模型。

---

## 4. 步骤依赖与建议排期顺序

```
Step 0 ─┬─> Step 1 ─> Step 2 ─┬─> Step 3 ─> Step 4 ─┐
        │                     │                     ├─> Step 7
        └─────────────────────┴─> Step 5 <──────────┘
                                      Step 6（依赖 Step 2/3，可与 Step 4 并行）
```

- 关键路径：0 → 1 → 2 → 3 → 4 → 7。
- Step 5（前端）在 Step 3 有稳定 API 契约后即可并行启动。
- **里程碑**：Step 2 完成 = "数据可用"；Step 4 完成 = "可当后台用"；Step 7 完成 = "可交付"。

## 5. 交给模型时的通用约束（建议附在每个步骤提示词里）

1. 只读使用 SwanLab 仓库，**不修改其源码**；解析逻辑 import 或复制（保留 Apache-2.0 声明）。
2. 严格兼容文件头 version 2，不匹配时报错并提示 SDK 版本，不要静默跳过。
3. 所有文件读取按"可能正在被写入"处理：只读打开、容忍尾部截断、单条损坏即停。
4. 每步必须带测试与可运行的验收命令，不接受"仅代码无验证"的交付。
5. 不引入对 swanboard（beta 锁版本）和闭源 self-hosted 镜像的运行时依赖。

## 6. 总风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| 数据格式随 SDK 版本演进（header 不向下兼容） | 旧数据读不了 | 解析器集中封装版本分支；升级前跑 Step 1 回归 |
| swanlog 在网络存储（NAS）上高频写 | 增量解析性能 | 只读追加解析 + 偏移缓存；必要时本地缓存副本 |
| 前端大指标曲线卡顿 | 体验差 | 后端聚合/降采样（LTTB 等）+ 分页拉取 |
| 权限系统安全漏洞 | 数据泄露 | Step 4 用强模型 + 安全测试用例；最小权限默认拒绝 |
| 与官方 swanboard 数据重复建设 | 维护成本 | 本方案不依赖 swanboard；两者独立，可随时切回 `swanlab watch` |
