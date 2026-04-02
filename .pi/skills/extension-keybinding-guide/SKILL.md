---
name: extension-keybinding-guide
description: >
  Keybinding system for Pi extensions. Rules, verb set, footer
  layout and conventions for panels, gates and interactive
  prompts. Use when writing or modifying extensions that have
  user-facing UI.
---

# Extension Keybindings

Every panel, gate and interactive prompt in the extension
system follows the same input model. This skill defines what
that model is so new work stays consistent with the existing
codebase.

## The Five Rules

1. **No global keyboard shortcuts.** Features are accessed
   through slash commands only. The only exceptions are
   `Ctrl+Alt+F` and `Ctrl+Alt+M` for panel height toggling,
   which must work during panel display.

2. **Numbers for views, letters for actions.** View switching
   keys (`1`, `2`, `3`) and action keys (`r`, `p`, `w`) live
   in structurally separate namespaces. Collisions are
   impossible.

3. **Enter/Escape for the primary decision pair.** Enter is
   always the default forward action (approve, proceed,
   confirm). Escape is always cancel/dismiss. Zero letters
   to memorize for the most common interaction.

4. **Explicit letter for destructive or consequential actions.**
   Speed bumps prevent accidents. Delete is `d`,
   not Enter. Enter must never trigger a destructive action.

## What Not to Do

- No global shortcuts. Use slash commands.
- No Cancel as a letter action. Always Escape.
- No letter key for the primary forward action. Always Enter.
