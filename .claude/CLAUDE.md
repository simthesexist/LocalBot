<!-- GSD:project-start source:PROJECT.md -->

## Project

**Localbot**

Localbot is a local-first desktop AI agent app that lets you create and run multiple specialized AI "bots" — each with its own persona, toolset, workspace, and persistent memory. Bots can read and edit files, run shell commands, search code with ripgrep, and drive a browser. They persist across sessions and can run on scheduled routines. The app integrates with your local Obsidian vault as a knowledge source and write target, and is reachable from your phone over Tailscale.

Built for a single user on a single Windows PC that stays on 24/7.

**Core Value:** A private, persistent, multi-agent AI coding/dev assistant that knows your codebase, learns from prior runs, and never leaves your machine.

If everything else fails, this must work: **the chat → LLM → tool → result loop, with persistent agent memory, fully on your own PC.**

### Constraints

- **Tech stack**: Electron + React 19 + TypeScript + Node 20+. Use Electron over Tauri because we need native Node access for the tool daemon and Playwright.
- **Single machine**: No distributed architecture, no cloud backend, no sync engine. Everything reads from and writes to the local filesystem.
- **Anthropic SDK**: Use `@anthropic-ai/sdk` for streaming + tool_use. Don't roll our own.
- **Local-only LLM calls**: M3 API is the only network dependency. Localhost defaults; no telemetry, no Sentry, no Statsig (unlike Grokbot).
- **No native modules that require building**: Pre-built binaries only (electron, playwright, tree-sitter). Avoid node-gyp compile steps.
- **Windows-first**: Build for Windows 11. Cross-platform later.

<!-- GSD:project-end -->

<!-- GSD:stack-start source:STACK.md -->

## Technology Stack

Technology stack not yet documented. Will populate after codebase mapping or first phase.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
