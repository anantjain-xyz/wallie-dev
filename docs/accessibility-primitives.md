# Accessible overlay and composite-control primitives

Application code imports these wrappers from `src/components/ui`. Direct `@radix-ui/*` imports are
restricted to that directory by ESLint so focus, portals, dismissal, motion, and styling remain a
design-system responsibility.

| Interaction              | Wallie primitive             | Use it for                                                                                                                                                                      |
| ------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Destructive confirmation | `AlertDialog`                | An irreversible or high-impact decision that requires an explicit cancel or action. Outside press does not dismiss it.                                                          |
| Non-destructive modal    | `Dialog`                     | Focused forms and tasks that can safely dismiss with Escape or outside press. Set `dismissible={false}` only while dismissal would lose in-flight work.                         |
| Menu actions             | `DropdownMenu`               | A compact set of actions. Do not use it for choosing a persisted form value.                                                                                                    |
| Selection                | `Select` / `SelectField`     | Choosing one value from a known list, with Arrow keys, Home/End, typeahead, and collision-aware positioning.                                                                    |
| Supplementary help       | `Tooltip`                    | Short, nonessential context that is also revealed on keyboard focus. Keep the trigger independently labelled; never substitute a `title` attribute.                             |
| Asynchronous status      | `useToast` / `useLiveRegion` | Use a polite toast for routine completion or progress and an assertive toast for a failure that needs immediate attention. Use `announce` when no visible toast is appropriate. |

## Shared behavior

`OverlayProvider` is mounted once in the root layout. It owns `#wallie-overlay-root`, tooltip timing,
the toast viewport, and one polite plus one assertive live region. Every portalled wrapper targets that
root and uses the z-index, geometry, color, and motion tokens in `globals.css`.

Radix modal primitives provide focus trapping, background inerting, scroll locking, Escape behavior,
and focus restoration. Dialog and alert-dialog content require a title at the type boundary; alert
dialogs also require a description. Menus require a content label. `SelectField` requires its visible
label, while the lower-level `SelectTrigger` requires `accessibleLabel`.

The development-only `/dev/ui-primitives` route exercises all six patterns in light, dark, and a
reduced-motion override. The override exists only for deterministic visual testing; the production
styles also honor `prefers-reduced-motion: reduce`.
