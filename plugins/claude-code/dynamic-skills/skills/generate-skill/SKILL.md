---
name: generate-skill
description: Generate a new, checked, repository-specific skill with Dynamic Skills for a task the user names explicitly.
disable-model-invocation: true
argument-hint: "[task description]"
---

# Generate a skill

The user asked explicitly for a new Dynamic Skills skill for this task:

$ARGUMENTS

If the task above is empty, ask the user which task the skill is for, then continue.

1. Follow the Protocol in the `dynamic-skill-bootstrap` skill from this plugin. Skip its "When to invoke" checks: the user asked for generation directly.
2. Start the run with `--force-generate`, so an existing skill is not reused:
   `dynamic-skills run start --harness claude --force-generate --task "<the task above, as one paragraph>"`
   `dynamic-skills` is on your Bash PATH through this plugin. If it is not, use `npx --yes dynamic-skills`.
3. Continue with the remaining protocol steps (analyse, clarify, compile, use, persistence) exactly as the bootstrap describes, including its fallback rules and the 60-second budget.
4. When the skill is active, apply it and finish the user's task. Ask before persisting it.
