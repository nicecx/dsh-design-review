# Mini 保养 skill 复用评估清单（2026-09-01 交付）

> 给 Mini 保养会话的复用评估参考（036 规范：开发前三查）。
> 本清单由主会话按 CAPABILITY-INDEX / awesome / GitHub 三源检索产出。

## 1. 本地已有能力（CAPABILITY-INDEX）

| 能力 | 复用方式 |
|---|---|
| **dsh-macos-calendar**（已部署） | ⭐ **首选载体**：保养提醒本质 = 周期日历事件（如每 6 个月保养、每 1 万公里换油）。直接用 calendar_add/calendar_events 工具建周期提醒，**无需新造提醒机制** |
| dsh-schedule（会话提醒） | 补充：短期提醒（如"本周六去保养"）可用会话 schedule |
| dsh-relay（iMessage） | 可选：保养到期推送手机 |
| dsh-task-watchdog | 可选：周期巡检任务心跳 |

## 2. 外部收录（awesome-dsh-plugin）

- 检索 `data/plugins/`：无直接"车辆保养"插件（2712 个插件中以日历/提醒/调度类为主，与本地 calendar 重叠）
- 结论：**外部无必需项**，日历提醒类方案本地已具备

## 3. GitHub 借鉴

- 车辆保养提醒类开源项目多为**独立 app**（非 DSH 插件），如车主 App 的保养提醒模块——架构思路可参考（里程/时间双触发），但接入成本高于本地日历方案
- 本次检索到的 dsh-tidewatch（时段调度）与本需求无关

## 4. 结论（推荐实现路径）

```
skill-maintenance（元规范）+ vehicle-maintenance（功能）分离 ✓（Mini 会话已定）
功能实现：
  1. 里程/时间双触发逻辑（skill 内纯逻辑）
  2. 提醒落地 = 复用 dsh-macos-calendar（周期事件）
  3. 可选：dsh-relay iMessage 推送
无需自建：提醒调度、日历存储、推送通道——全部本地已有
```

**本轮教训引用**：036 复用评估强制关卡 + 20260901-015（方案 A：skill 开发路径也挂关卡）——今后 skill 开发自动触发三查。
