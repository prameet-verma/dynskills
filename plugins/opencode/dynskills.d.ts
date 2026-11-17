// Type declarations for dynskills.js (used by the TypeScript tests; not installed into OpenCode).

export interface LiveSkill {
  id: string;
  name: string;
  description?: string;
  /** Absolute path of the skill's SKILL.md. */
  path: string;
  /** SKILL.md body without frontmatter. */
  content: string;
}

export interface SkillInfoLike {
  id: string;
  name: string;
  description?: string;
  autoinvoke?: boolean;
  path: string;
  content: string;
}

export interface SkillEditorLike {
  list(): readonly SkillInfoLike[];
  get(id: string): SkillInfoLike | undefined;
  add(skill: SkillInfoLike): void;
  update(id: string, update: (skill: SkillInfoLike) => void): void;
  remove(id: string): void;
}

export interface ApplyState {
  owned: Set<string>;
}

export interface ApplyResult {
  added: string[];
  updated: string[];
  removed: string[];
  errors: Array<{ id: string; message: string }>;
}

export interface Brands {
  id(v: string): string;
  name(v: string): string;
  path(v: string): string;
}

export const PLUGIN_ID: string;
export const PLUGIN_MARKER: string;
export const COMMAND_NAME: string;
export const DEBOUNCE_MS: number;
export const POLL_INTERVAL_MS: number;

export function liveSkillsFileFor(root: string): string;
export function readLiveSkills(file: string): LiveSkill[] | undefined;
export function resolveBrands(pluginModule: unknown): Brands;
export function applyLiveSkills(
  editor: SkillEditorLike,
  skills: readonly LiveSkill[],
  state?: ApplyState,
  opts?: { brands?: Brands; fileExists?: (p: string) => boolean },
): ApplyResult;
export function mergeLiveSkills(lists: ReadonlyArray<readonly LiveSkill[]>): LiveSkill[];
export function debounce(fn: () => void, ms: number): (() => void) & { cancel(): void };
export function watchLiveSkillsFile(file: string, onChange: () => void, opts?: { pollIntervalMs?: number }): () => void;
export function commandPrompt(task: string | undefined): string;

export interface PluginDefinition {
  id: string;
  setup(ctx: unknown): Promise<() => void>;
}

export function createDynamicSkillsPlugin(options?: { pluginModule?: unknown; debounceMs?: number; pollIntervalMs?: number }): PluginDefinition;

declare const plugin: PluginDefinition;
export default plugin;
