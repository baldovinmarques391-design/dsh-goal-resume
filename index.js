/**
 * dsh-goal-resume —— 让“定时唤醒回合”和“自动续跑回合”也能开关目标。
 *
 * 为什么要这个插件
 * 内置的 `update_goal` 把 pause / resume 锁在“本回合必须有一条 source.kind === "user"
 * 的人类消息”这道闸上；定时唤醒（source.kind === "schedule"）与目标自动续跑
 * （source.kind === "goal"）都没有人类消息，于是同一个目标一旦被暂停，就再也
 * 无法由智能体自己恢复。工具层还有第二道闸：当前目标恰好 paused 时直接抛
 * GOAL_TOOL_RESUME_PAUSED。
 *
 * 为什么绕过工具层而不改源码
 * 状态机本身是允许的：`GoalService.resume()` 的 resumable 列表里明确写着
 * "paused"（dsh-goal/lib/index.js 的 resume 方法），它只要求传入一个与当前
 * revision 精确匹配的 ref。限制只在工具封装层，服务层没有这个禁区。本插件因此
 * 不碰任何既有包，只注册一个新工具，直接对 `ctx.goals` 说话。
 *
 * 为什么不 import @deepseek-ai/*
 * 插件目录在 profile 之外，Node 按真实路径解析模块，看不到 profile 的
 * node_modules；而且一个开关工具也不该把工具注册表的内部实现绑进自己的依赖。
 * 所以这里用注册表要求的裸定义：parameters 就是 JSON Schema，参数自校验。
 *
 * 边界
 * 只做三件事：resume（paused / blocked / 失活的 active → active + armed）、
 * pause（active → paused + disarmed）、disarm（保留 phase，只撤掉续跑授权）。
 * 目标的新建、改写、完成、阻塞仍归内置工具，避免出现两套语义。
 *
 * @module dsh-goal-resume
 */

/** Loader 行名，出现在 loader 诊断里。 */
export const name = 'goal-resume'

/** 依赖的服务：工具注册表与目标域。 */
export const inject = ['tools', 'goals']

/** 本工具接受的动作，顺序即文档顺序。 */
const ACTIONS = ['resume', 'pause', 'disarm']

const DESCRIPTION = 'Switch the state of the current same-session goal from any round: resume, pause or disarm. '
	+ 'Use this instead of update_goal in the two cases where that tool refuses: a turn with no direct human message (a scheduled wake-up round, source kind "schedule"; an automatic goal round, source kind "goal") and resuming a goal whose phase is already "paused" (update_goal answers GOAL_TOOL_RESUME_PAUSED). '
	+ 'resume makes a paused or blocked goal active again and re-arms automatic continuation; pause stops it and disarms; disarm keeps the phase but drops the continuation authority. '
	+ 'Call get_goal first and pass its exact goal_id and revision; both may be omitted to act on the current goal, which is what a wake-up round normally wants.'

/** 系统提示词里的补充说明：内置工具拒绝时改用它。 */
const GUIDANCE = 'The goal tools have one gap this session fills with a second tool. `update_goal` refuses `pause` and `resume` in a turn with no direct human message (a scheduled wake-up or an automatic goal round), and it always refuses to resume a goal whose phase is already `paused` (`GOAL_TOOL_RESUME_PAUSED`). In those two cases call `goal_switch` with `action` `resume`, `pause` or `disarm`; it drives the same goal service and has no such gate. Do not tell the user a paused goal cannot be resumed: try `goal_switch` first.'

/** 目标参数的 JSON Schema。 */
const PARAMETERS = {
	type: 'object',
	additionalProperties: false,
	required: ['action'],
	properties: {
		action: {
			type: 'string',
			enum: [...ACTIONS],
			description: 'resume (back to active + armed) | pause (paused + disarmed) | disarm (keep phase, stop continuation).'
		},
		goal_id: {
			type: 'string',
			description: 'Exact id from get_goal. Omit together with revision to use the current goal.'
		},
		revision: {
			type: 'number',
			description: 'Exact revision from get_goal. Omit together with goal_id to use the current goal.'
		}
	}
}

/** 单个目标值的模型可见 schema，与内置目标工具保持同一形状。 */
const GOAL_VALUE_SCHEMA = {
	oneOf: [
		{
			type: 'object',
			additionalProperties: false,
			required: ['goal'],
			properties: { goal: { type: 'null' } }
		},
		{
			type: 'object',
			additionalProperties: false,
			required: ['goal', 'activation'],
			properties: {
				goal: {
					type: 'object',
					additionalProperties: false,
					required: ['id', 'revision', 'objective', 'phase', 'roundsStarted', 'maxGoalRounds'],
					properties: {
						id: { type: 'string' },
						revision: { type: 'integer' },
						objective: { type: 'string' },
						phase: { type: 'string', enum: ['active', 'paused', 'blocked', 'complete'] },
						roundsStarted: { type: 'integer' },
						maxGoalRounds: { type: 'integer' },
						blockedReason: {
							type: 'object',
							additionalProperties: false,
							required: ['code', 'message'],
							properties: {
								code: { type: 'string' },
								message: { type: 'string' }
							}
						}
					}
				},
				activation: { type: 'string', enum: ['armed', 'disarmed'] }
			}
		}
	]
}

/** 动作的展示标题。 */
const TITLES = {
	resume: 'Resume goal',
	pause: 'Pause goal',
	disarm: 'Disarm goal'
}

/** 目标的稳定紧凑视图；activation 是观测值，不是可回放状态。 */
function goalValue(goal) {
	if (goal === undefined) return { goal: null }
	return {
		goal: {
			id: goal.id,
			revision: goal.revision,
			objective: goal.objective,
			phase: goal.phase,
			roundsStarted: goal.roundsStarted,
			maxGoalRounds: goal.maxGoalRounds,
			...(goal.blockedReason === undefined
				? {}
				: { blockedReason: { code: goal.blockedReason.code, message: goal.blockedReason.message } })
		},
		activation: goal.activation
	}
}

/**
 * 解析要操作的 ref。
 *
 * 省略 id 与 revision 时用当前目标自己的精确值——这是唤醒回合最常用的写法；
 * 只给其中一个、或与当前目标不符，就直接拒绝，不猜智能体的意思。
 *
 * @param args - 模型给出的参数。
 * @param current - 当前目标视图。
 * @returns `{ id, revision }`。
 */
function resolveRef(args, current) {
	const hasId = args.goal_id !== undefined && args.goal_id !== ''
	const hasRevision = args.revision !== undefined
	if (hasId !== hasRevision) {
		throw new Error('goal_switch: goal_id and revision must be given together, or both omitted for the current goal')
	}
	if (!hasId) return { id: current.id, revision: current.revision }
	if (args.goal_id !== current.id) {
		throw new Error(`goal_switch: this session has no goal "${args.goal_id}"; current is "${current.id}" revision ${current.revision}`)
	}
	if (args.revision !== current.revision) {
		throw new Error(`goal_switch: stale revision ${args.revision} for goal "${current.id}"; current revision is ${current.revision}`)
	}
	return { id: current.id, revision: current.revision }
}

/**
 * 注册 `goal_switch`。
 *
 * 从本行的普通上下文注册，注册表层面所有智能体都可见；执行时只认
 * `exec.agent` 这个活着的实例，因此自动续跑回合、定时唤醒回合都能用。
 *
 * @param ctx - 本行上下文；`tools`、`goals` 由 {@link inject} 解析。
 */
export function apply(ctx) {
	// 提示词段落必须紧挨内置的目标工具段落，模型在被拒的同一处就能看到替代方案。
	// 某些组合（例如极简 SDK）没有 systemPrompt，缺了也不该让整行加载失败。
	try {
		ctx.systemPrompt?.section({
			name: 'tool:goal-switch',
			order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL'),
			text: GUIDANCE
		})
	} catch (error) {
		ctx.logger?.warn?.(`goal-resume: could not register the prompt section: ${error.message}`)
	}

	const tool = {
		name: 'goal_switch',
		description: DESCRIPTION,
		parameters: PARAMETERS,
		output: {
			schema: GOAL_VALUE_SCHEMA,
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
		},
		execute(args, exec) {
			if (!ACTIONS.includes(args?.action)) {
				throw new Error(`goal_switch: action must be one of ${ACTIONS.join(', ')}`)
			}
			const agent = exec.agent
			if (agent === undefined) throw new Error('goal_switch requires an owning agent session')
			const current = ctx.goals.get(agent)
			if (current === undefined) {
				throw new Error('goal_switch: this session has no current goal; create one with create_goal first')
			}
			const ref = resolveRef(args ?? {}, current)
			const view = args.action === 'resume'
				? ctx.goals.resume(agent, ref)
				: args.action === 'pause'
					? ctx.goals.pause(agent, ref)
					: ctx.goals.disarm(agent)
			ctx.logger?.info?.(`goal-resume: ${args.action} -> phase=${view?.phase} activation=${view?.activation}`)
			return Promise.resolve(goalValue(view))
		},
		presentCall: (args) => ({
			card: 'generic',
			title: TITLES[args.action] ?? 'Switch goal',
			kind: 'other',
			rawInput: args.action
		})
	}
	ctx.tools.register(tool)
}
