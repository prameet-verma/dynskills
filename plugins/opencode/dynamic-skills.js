// @dynamic-skills-opencode-plugin v1
//
// Dynamic Skills integration for OpenCode V2 (installed by `dynamic-skills init` into
// `.opencode/plugins/` or `~/.config/opencode/plugins/`).
//
// It does two things:
//   (a) adds a `dynamic-skills` command (via `ctx.command.transform`, when available) that asks the
//       agent to run the Dynamic Skills protocol with `--force-generate` for the given task;
//   (b) live-registers skills that Dynamic Skills activated for this project. The OpenCode adapter
//       writes them to `<project>/.dynamic-skills-runtime/live-skills/opencode.json`; this plugin
//       adds/updates them in the skill registry with `ctx.skill.transform`, watches that file and
//       calls `ctx.skill.reload()` when it changes.
//
// This file is intentionally self-contained: OpenCode loads every direct `.js`/`.ts` file in a
// plugins directory as a plugin, so a separate helper module next to it would be loaded as a
// (broken) plugin too. The pure core (`readLiveSkills`, `applyLiveSkills`, ...) is exported by name
// for tests; OpenCode V2 reads only the default export's `id` and `setup()`.
//
// Verified against https://opencode.ai/docs/build/plugins/server/ : `Plugin.define({ id, setup })`
// from "@opencode/plugin"; `setup` may return a cleanup function; `ctx.location.{directory,
// project.directory}`; `ctx.options`; `ctx.skill.transform(cb)`, `ctx.skill.reload()`, editor
// `list/get/add/update/remove`; `ctx.command.transform(e => e.add({ name, description, execute }))`
// with `execute({ sessionID, prompt, delivery })` calling `ctx.session.prompt({ ...prompt,
// sessionID, text, delivery })`.
// NOT verified (handled defensively): whether "@opencode/plugin" is resolvable from a project
// plugin file (we fall back to exporting the plain `{ id, setup }` object); whether `transform`
// returns a disposable registration for commands; whether `Skill.ID.make`-style brands are required
// at runtime (we use them when the module is available, plain strings otherwise); whether the
// transform callback is replayed against a fresh registry or a persistent one (applyLiveSkills is
// correct for both).

/* global setTimeout, clearTimeout */
import { existsSync, readFileSync, unwatchFile, watch, watchFile } from "node:fs";
import path from "node:path";

export const PLUGIN_ID = "dynamic-skills";
export const PLUGIN_MARKER = "@dynamic-skills-opencode-plugin";
export const COMMAND_NAME = "dynamic-skills";
export const DEBOUNCE_MS = 150;
export const POLL_INTERVAL_MS = 1000;

const SKILL_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `<root>/.dynamic-skills-runtime/live-skills/opencode.json` (must match src/activation/live-skills.ts). */
export function liveSkillsFileFor(root) {
  return path.join(root, ".dynamic-skills-runtime", "live-skills", "opencode.json");
}

function validEntry(e) {
  return (
    e !== null &&
    typeof e === "object" &&
    typeof e.id === "string" &&
    SKILL_ID_RE.test(e.id) &&
    e.id.length <= 64 &&
    typeof e.name === "string" &&
    e.name.length > 0 &&
    typeof e.path === "string" &&
    path.isAbsolute(e.path) &&
    typeof e.content === "string" &&
    (e.description === undefined || typeof e.description === "string")
  );
}

/**
 * Read the live-skill file. Returns `[]` when it does not exist and `undefined` when it exists but
 * cannot be parsed (callers keep their previous state). Invalid entries are dropped; the last entry
 * wins for duplicate ids.
 */
export function readLiveSkills(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    return err && err.code === "ENOENT" ? [] : undefined;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.skills) ? data.skills : undefined;
  if (!list) return undefined;
  const byId = new Map();
  for (const e of list) {
    if (!validEntry(e)) continue;
    byId.set(e.id, { id: e.id, name: e.name, ...(e.description !== undefined ? { description: e.description } : {}), path: e.path, content: e.content });
  }
  return [...byId.values()];
}

const identity = (v) => v;

/** Branding helpers from "@opencode/plugin" (`Skill.ID.make`, ...) when available; identity otherwise. */
export function resolveBrands(pluginModule) {
  const Skill = pluginModule && pluginModule.Skill;
  const pick = (fn) => (typeof fn === "function" ? fn : identity);
  return {
    id: pick(Skill && Skill.ID && Skill.ID.make),
    name: pick(Skill && Skill.Name && Skill.Name.make),
    path: pick(Skill && Skill.Info && Skill.Info.fields && Skill.Info.fields.path && Skill.Info.fields.path.make),
  };
}

function toSkillInfo(skill, brands) {
  return {
    id: brands.id(skill.id),
    name: brands.name(skill.name),
    ...(skill.description !== undefined ? { description: skill.description } : {}),
    path: brands.path(skill.path),
    content: skill.content,
  };
}

/**
 * Apply live skills to an OpenCode skill editor: add missing ids, update existing ones, and remove
 * ids this plugin registered earlier that are no longer live. A stale id is only removed when the
 * SKILL.md at its registered path no longer exists, so a skill that is still on disk (for example one
 * the user persisted) stays with OpenCode's directory discovery. `state.owned` carries the ids
 * registered by the previous application.
 */
export function applyLiveSkills(editor, skills, state = { owned: new Set() }, opts = {}) {
  const brands = opts.brands ?? resolveBrands(undefined);
  const fileExists = opts.fileExists ?? existsSync;
  const result = { added: [], updated: [], removed: [], errors: [] };
  const next = new Set();
  for (const skill of skills) {
    try {
      const info = toSkillInfo(skill, brands);
      if (editor.get(info.id) !== undefined) {
        editor.update(info.id, (s) => {
          s.name = info.name;
          if (info.description !== undefined) s.description = info.description;
          s.path = info.path;
          s.content = info.content;
        });
        result.updated.push(skill.id);
      } else {
        editor.add(info);
        result.added.push(skill.id);
      }
      next.add(skill.id);
    } catch (err) {
      result.errors.push({ id: skill.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const id of state.owned ?? []) {
    if (next.has(id)) continue;
    try {
      const current = editor.get(id);
      if (current === undefined) continue;
      if (typeof current.path === "string" && fileExists(String(current.path))) continue;
      editor.remove(id);
      result.removed.push(id);
    } catch (err) {
      result.errors.push({ id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  state.owned = next;
  return result;
}

/** Merge per-file skill lists (later files win for duplicate ids). */
export function mergeLiveSkills(lists) {
  const byId = new Map();
  for (const list of lists) for (const s of list) byId.set(s.id, s);
  return [...byId.values()];
}

export function debounce(fn, ms) {
  let timer;
  const debounced = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, ms);
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return debounced;
}

/**
 * Watch a live-skill file. Watches its directory (the file is replaced by an atomic rename, which a
 * file-level watch would lose); when the directory does not exist yet, falls back to stat polling,
 * which also works for files that do not exist yet. Returns a close function.
 */
export function watchLiveSkillsFile(file, onChange, opts = {}) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  try {
    const watcher = watch(dir, { persistent: false }, (_event, name) => {
      if (!name || String(name) === base) onChange();
    });
    watcher.on("error", () => {});
    return () => watcher.close();
  } catch {
    const listener = () => onChange();
    watchFile(file, { persistent: false, interval: opts.pollIntervalMs ?? POLL_INTERVAL_MS }, listener);
    return () => unwatchFile(file, listener);
  }
}

export function commandPrompt(task) {
  const t = typeof task === "string" ? task.trim() : "";
  return [
    'Load the `dynamic-skill-bootstrap` skill with the skill tool and run its Dynamic Skills protocol for the task below. Skip its "When to invoke" checks: the user asked for a generated skill explicitly.',
    'Start the run with `dynamic-skills run start --harness opencode --force-generate --task "<task>"` (use `npx --yes dynamic-skills` if `dynamic-skills` is not on PATH), then follow each step\'s `next` field. Ask before persisting the skill.',
    "",
    t ? `Task: ${t}` : "Task: (none given. Ask the user which task the skill is for.)",
  ].join("\n");
}

function dispose(registration) {
  try {
    if (registration && typeof registration.dispose === "function") return registration.dispose();
  } catch {
    // ignore: cleanup must not throw
  }
  return undefined;
}

function liveSkillFiles(ctx) {
  const options = (ctx && ctx.options) || {};
  if (typeof options.liveSkillsFile === "string" && options.liveSkillsFile) return [path.resolve(options.liveSkillsFile)];
  const location = (ctx && ctx.location) || {};
  const roots = [options.projectRoot, location.project && location.project.directory, location.directory].filter((r) => typeof r === "string" && r);
  return [...new Set(roots.map((r) => liveSkillsFileFor(path.resolve(r))))];
}

/** Build the plugin definition (`{ id, setup }`). `pluginModule` is "@opencode/plugin" when importable. */
export function createDynamicSkillsPlugin(options = {}) {
  const brands = resolveBrands(options.pluginModule);
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  return {
    id: PLUGIN_ID,
    async setup(ctx) {
      const cleanups = [];

      // (a) explicit command
      if (ctx && ctx.command && typeof ctx.command.transform === "function" && ctx.session && typeof ctx.session.prompt === "function") {
        const registration = await ctx.command.transform((editor) => {
          editor.add({
            name: COMMAND_NAME,
            description: "Generate a checked, repository-specific skill for a task with Dynamic Skills",
            execute: async ({ sessionID, prompt, delivery }) => {
              await ctx.session.prompt({ ...(prompt || {}), sessionID, text: commandPrompt(prompt && prompt.text), delivery });
            },
          });
        });
        cleanups.push(() => dispose(registration));
      }

      // (b) live skill registration
      if (!ctx || !ctx.skill || typeof ctx.skill.transform !== "function") {
        return () => cleanups.forEach((c) => c());
      }
      const files = liveSkillFiles(ctx);
      const perFile = new Map(files.map((f) => [f, readLiveSkills(f) ?? []]));
      let current = mergeLiveSkills([...perFile.values()]);
      let snapshot = JSON.stringify(current);
      const state = { owned: new Set() };
      const registration = await ctx.skill.transform((editor) => {
        applyLiveSkills(editor, current, state, { brands });
      });
      cleanups.push(() => dispose(registration));

      let closed = false;
      const refresh = async () => {
        if (closed) return;
        for (const f of files) {
          const next = readLiveSkills(f);
          if (next !== undefined) perFile.set(f, next);
        }
        const merged = mergeLiveSkills([...perFile.values()]);
        const nextSnapshot = JSON.stringify(merged);
        if (nextSnapshot === snapshot) return;
        current = merged;
        snapshot = nextSnapshot;
        if (typeof ctx.skill.reload === "function") await ctx.skill.reload();
      };
      const onChange = debounce(() => {
        refresh().catch(() => {});
      }, debounceMs);
      cleanups.push(() => onChange.cancel());
      for (const f of files) cleanups.push(watchLiveSkillsFile(f, onChange, options));
      return () => {
        closed = true;
        for (const c of cleanups.reverse()) c();
      };
    },
  };
}

let pluginModule;
try {
  const specifier = "@opencode/plugin";
  pluginModule = await import(/* @vite-ignore */ specifier);
} catch {
  pluginModule = undefined;
}

const definition = createDynamicSkillsPlugin({ pluginModule });

function define(def) {
  const fn = pluginModule && pluginModule.Plugin && pluginModule.Plugin.define;
  if (typeof fn !== "function") return def;
  try {
    return fn(def);
  } catch {
    return def;
  }
}

export default define(definition);
