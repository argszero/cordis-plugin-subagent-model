/**
 * Live model selection for dsh subagents.
 *
 * A delegation inherits the parent's route and nothing can name a different
 * one for it. `resolveChildAgentOptions` copies the parent's latest request
 * header into the child's `AgentOptions`, and the only per-child lever is
 * `agentOptions` at delegation time, so a subagent always runs on the parent's
 * current model and a running child's route is fixed for the whole run.
 * Nothing shows the child's route either: the durable request header carries
 * it, but the transcript a user reads does not.
 *
 * Mounted on two public seams:
 *
 * 1. **`agent/request`** — for every Agent whose delegation depth is at least
 *    one, the resolved config is rewritten to this plugin's live selection.
 *    Selection is resolved per request rather than per run, so a change takes
 *    effect on a running child's next step, and the child never splits a step:
 *    the same route feeds its prompt assembly and its dispatch.
 * 2. **`subagent_model`** — a model-facing tool that reads and writes that
 *    selection at runtime. The user reaches it through the agent they are
 *    already talking to, which is the only switch a subagent has. Writing is
 *    restricted to a top-level agent: the selection is deployment-wide for
 *    subagents, so a child silently re-routing its siblings would be a
 *    privilege the report did not ask for.
 *
 * Visibility (`announce`, on by default) reuses the mechanism the harness
 * itself uses for a root model switch: a durable user-role notice injected at
 * the child's next admitted step. The first notice states the route the child
 * runs on; a later route change states the boundary, so a transcript whose
 * turns came from two models says so. Both are ordinary session events, so
 * they survive resume and are visible wherever the child's transcript is.
 *
 * Scope: in-process children (spawn / fork / continuation providers). An
 * out-of-process child has no `agent/request` in this process, so its route is
 * untouched here by construction.
 *
 * @module @argszero/cordis-plugin-subagent-model
 */
import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { boundContextSummary, createUserMessage, } from '@deepseek-ai/dsh-llm';
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent';
export const name = 'subagent-model';
export const inject = ['tools'];
export const Config = z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string(),
    toolName: z.string().default('subagent_model'),
    announce: z.boolean().default(true),
});
/** Whether the selection names anything at all. */
function names(selection) {
    return selection.provider !== undefined
        || selection.model !== undefined
        || selection.reasoningEffort !== undefined;
}
/**
 * Display form of one resolved route. A field the route does not carry is
 * reported as inherited rather than invented, so a half-specified override
 * never reads as an unknown provider.
 */
function routeLabel(provider, model) {
    if (provider === undefined && model === undefined)
        return 'unset';
    return `${provider ?? 'inherited'}/${model ?? 'inherited'}`;
}
/**
 * Display form of the selection itself: exactly the fields it names, so a
 * model-only override does not pretend to name a provider.
 */
function selectionLabel(selection) {
    const parts = [];
    if (selection.provider !== undefined)
        parts.push(`provider=${selection.provider}`);
    if (selection.model !== undefined)
        parts.push(`model=${selection.model}`);
    if (selection.reasoningEffort !== undefined)
        parts.push(`reasoningEffort=${selection.reasoningEffort}`);
    return parts.length === 0 ? 'none' : parts.join(' ');
}
/**
 * Rewrite one resolved request config to the selection.
 *
 * A selection that changes the route without naming an effort clears the
 * inherited effort, mirroring `resolveChildAgentOptions`: the effort belonged
 * to the route that carried it, so the newly selected model resolves its own
 * default instead of inheriting a level its adapter may not offer.
 * @param resolved - the config downstream listeners resolved.
 * @param selection - the live selection to apply.
 * @returns the rewritten config, or `resolved` when nothing changes.
 */
export function applySelection(resolved, selection) {
    const provider = selection.provider ?? resolved.provider;
    const model = selection.model ?? resolved.model;
    const effort = selection.reasoningEffort;
    const routeChanged = provider !== resolved.provider || model !== resolved.model;
    if (!routeChanged) {
        if (effort === undefined)
            return resolved;
        return { ...resolved, provider, model, reasoningEffort: effort };
    }
    const { reasoningEffort: _inherited, ...rest } = resolved;
    return {
        ...rest,
        provider,
        model,
        ...effort === undefined ? {} : { reasoningEffort: effort },
    };
}
/**
 * The route one agent's next request will use: the selection where it names a
 * field, the agent's own resolved options elsewhere. On a child those options
 * already carry the route the delegation inherited.
 * @param agent - the agent whose route is being resolved.
 * @param selection - the live selection.
 * @returns the route as display parts, either of which may be absent.
 */
function effectiveRoute(agent, selection) {
    const configured = agent.session.requestHeader()?.config;
    return {
        provider: selection.provider ?? configured?.provider ?? agent.options.provider,
        model: selection.model ?? configured?.model ?? agent.options.model,
    };
}
/** One plugin-owned notice: a durable user-role fact, not model-authored text. */
function notice(text, summary) {
    return createUserMessage({
        content: [{ type: 'text', text }],
        source: {
            kind: 'subagent-model',
            plugin: name,
            form: 'notice',
            summary: boundContextSummary(summary),
        },
    });
}
/** Render one report as the single line a user reads. */
function reportLine(report) {
    const selection = report.selection === 'none'
        ? 'subagents inherit the parent route'
        : `subagents run on ${report.selection}`;
    return `${report.action}: ${selection}; this ${report.role} will use ${report.route} (${report.source})`;
}
/**
 * Register the model-facing tool that reads and writes the selection.
 * @param ctx - host context.
 * @param config - plugin configuration.
 * @param selection - the live selection this plugin applies.
 * @returns the tool disposer.
 */
function mountTool(ctx, config, selection) {
    const toolName = config.toolName ?? 'subagent_model';
    const build = (action, agent) => {
        const role = delegationDepthOf(agent) === 0 ? 'root agent' : 'subagent';
        const route = effectiveRoute(agent, selection);
        return {
            action,
            role,
            selection: selectionLabel(selection),
            route: routeLabel(route.provider, route.model),
            source: role !== 'subagent' ? 'unset' : names(selection) ? 'selection' : 'inherited',
        };
    };
    return ctx.tools.register(defineTool({
        name: toolName,
        description: 'Read or change the model that subagents run on. Subagents inherit the model of the agent that delegates to them; this tool gives them a route of their own. Use action "set" to name a provider, model, and/or reasoning_effort for every subagent request from now on — a subagent that is already running follows it from its next step — and action "get" to see the current selection and the route the caller itself uses. Only a top-level agent may set: the selection is deployment-wide for subagents.',
        parameters: {
            action: {
                type: 'string',
                enum: ['get', 'set'],
                description: 'Read the current selection ("get", the default) or change it ("set").',
            },
            provider: {
                type: 'string',
                description: 'Provider route for subagent requests. Omit to keep the inherited provider.',
            },
            model: {
                type: 'string',
                description: 'Model id for subagent requests. Omit to keep the inherited model.',
            },
            reasoning_effort: {
                type: 'string',
                description: 'Reasoning effort for subagent requests, in the selected route\'s vocabulary. Naming a route without an effort lets that route resolve its own default.',
            },
            clear: {
                type: 'boolean',
                description: 'Remove the selection entirely, returning subagents to inherited routing.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    action: { type: 'string', required: true },
                    role: { type: 'string', required: true },
                    selection: { type: 'string', required: true },
                    route: { type: 'string', required: true },
                    source: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: reportLine(value) }],
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const agent = exec.agent;
            if (agent === undefined) {
                throw new Error(`${toolName} requires a calling agent (exec.agent was undefined)`);
            }
            const action = args.action ?? 'get';
            const clearing = args.clear === true;
            if (action === 'get' && !clearing)
                return build('get', agent);
            const depth = delegationDepthOf(agent);
            if (depth !== 0) {
                throw new Error(`${toolName} cannot change the subagent selection from a delegated agent (depth ${depth}): the selection is deployment-wide for every subagent, so only a top-level agent may write it. Use action "get" to read the route this subagent runs on.`);
            }
            if (clearing) {
                delete selection.provider;
                delete selection.model;
                delete selection.reasoningEffort;
                return build('set', agent);
            }
            if (args.provider === undefined && args.model === undefined && args.reasoning_effort === undefined) {
                throw new Error(`${toolName} set requires at least one of provider, model, or reasoning_effort (or clear: true)`);
            }
            if (args.provider !== undefined)
                selection.provider = args.provider;
            if (args.model !== undefined)
                selection.model = args.model;
            if (args.reasoning_effort !== undefined)
                selection.reasoningEffort = args.reasoning_effort;
            ctx.logger.info(`subagent selection is now ${selectionLabel(selection)}`);
            return build('set', agent);
        },
    }));
}
/**
 * Mount the plugin: route injection, transcript notices, and the runtime tool.
 * @param ctx - host context.
 * @param config - plugin configuration.
 */
export function apply(ctx, config) {
    const selection = {};
    if (config.provider !== undefined)
        selection.provider = config.provider;
    if (config.model !== undefined)
        selection.model = config.model;
    if (config.reasoningEffort !== undefined)
        selection.reasoningEffort = config.reasoningEffort;
    /** Route already announced per child session, so a resume does not repeat it. */
    const announced = new Map();
    ctx.on('agent/request', async (payload, next) => {
        const resolved = await next();
        if (delegationDepthOf(payload.agent) === 0)
            return resolved;
        if (!names(selection))
            return resolved;
        return applySelection(resolved, selection);
    });
    ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
        const decision = await next();
        if (config.announce === false)
            return decision;
        if (decision.kind === 'reject' || signal.aborted)
            return decision;
        if (delegationDepthOf(agent) === 0)
            return decision;
        // The loop skips an empty first step and an emptied offered continuation.
        if (decision.messages.length === 0 && (step === 1 || messages.length > 0))
            return decision;
        const route = effectiveRoute(agent, selection);
        const current = routeLabel(route.provider, route.model);
        if (current === 'unset')
            return decision;
        const previous = announced.get(agent.id);
        const header = agent.session.requestHeader()?.config;
        const before = header === undefined ? undefined : routeLabel(header.provider, header.model);
        let text;
        if (previous === undefined) {
            text = `[subagent model: ${current}]`;
        }
        else if (before !== undefined && before !== current) {
            text = `[model changed: assistant turns above this point were generated by ${before}; the session continues with ${current}]`;
        }
        if (text === undefined)
            return decision;
        announced.set(agent.id, current);
        return { ...decision, messages: [...decision.messages, notice(text, `subagent model ${current}`)] };
    }, { prepend: true });
    ctx.on('agent/disposed', ({ agent }) => {
        announced.delete(agent.id);
    });
    mountTool(ctx, config, selection);
}
