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
import { type LlmCallConfig, type ReasoningEffortId } from '@deepseek-ai/dsh-llm';
export declare const name = "subagent-model";
export declare const inject: string[];
/**
 * The durable source kind this plugin stamps on the notices it injects.
 *
 * `MessageSourceMap` is merge-extensible and its base entry declares no shared
 * catch-all `plugin` kind: each producer names its own, which is what every
 * in-tree producer does (`dsh-schedule`, `dsh-time-context`, ...). Augmenting
 * the map here is therefore the successor to `kind: 'plugin'` — not a literal
 * bent to fit the union — and the `plugin` field is kept so the durable record
 * still answers which plugin sent it.
 */
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'subagent-model': {
            kind: 'subagent-model';
            plugin?: string;
            form?: 'notice';
            summary?: string;
        };
    }
}
/** Plugin configuration. */
export interface Config {
    /** Provider route applied to subagent requests; inherited when absent. */
    provider?: string;
    /** Model id applied to subagent requests; inherited when absent. */
    model?: string;
    /**
     * Reasoning effort applied to subagent requests, in the vocabulary of the
     * selected route's adapter. Absent means "let the selection's route decide",
     * which is also what a route change without a named effort restores.
     */
    reasoningEffort?: string;
    /** Model-facing tool name (default `subagent_model`). */
    toolName?: string;
    /** Inject a durable route notice into a child's transcript (default `true`). */
    announce?: boolean;
}
export declare const Config: z<Config>;
/**
 * One partial route override. An unset field keeps the value the delegation
 * inherited, so `{ model }` alone re-points the model inside the parent's
 * provider.
 */
export interface RouteSelection {
    /** Provider route override. */
    provider?: string;
    /** Model id override. */
    model?: string;
    /** Reasoning effort override; absent clears effort on a route change. */
    reasoningEffort?: ReasoningEffortId;
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
export declare function applySelection(resolved: LlmCallConfig, selection: RouteSelection): LlmCallConfig;
/**
 * Mount the plugin: route injection, transcript notices, and the runtime tool.
 * @param ctx - host context.
 * @param config - plugin configuration.
 */
export declare function apply(ctx: Context, config: Config): void;
