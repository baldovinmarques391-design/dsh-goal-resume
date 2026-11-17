# 目标恢复 · dsh-goal-resume

定时唤醒（`source.kind === "schedule"`）和目标自动续跑（`source.kind === "goal"`）的回合里没有人类消息，
内置 `update_goal` 的 `pause` / `resume` 在第一道闸就被拒；当前目标恰好是 `paused` 时，工具层还会再拦一次
（`GOAL_TOOL_RESUME_PAUSED`）。于是同一个目标一旦被暂停，智能体再也无法自己把它叫起来。

状态机本身没有这个禁区：`GoalService.resume()` 的 resumable 列表里就写着 `paused`。所以本插件不改任何既有包，
只注册一个新工具，直接对 `ctx.goals` 说话。

## 工具

`goal_switch(action, goal_id?, revision?)`

| action | 结果 |
|---|---|
| `resume` | `paused` / `blocked` / 失活的 `active` → `active` + `armed` |
| `pause` | `active` → `paused` + `disarmed` |
| `disarm` | 保留当前 phase，只撤掉续跑授权 |

`goal_id` 与 `revision` 要么都给、要么都省。都省时用当前目标自己的精确值——唤醒回合最常用的写法；
只给一个、或与当前目标不符，直接拒绝，不猜你的意思。

## 安装

```sh
dsh plugin --profile web add <本地路径>
```

再把 `dsh-goal-resume` 加进该 profile `package.json` 的 `dsh.profile.bundles`。

## 边界

只做开关。目标的新建、改写、完成、阻塞仍归内置的 `create_goal` / `update_goal`，避免出现两套语义。
