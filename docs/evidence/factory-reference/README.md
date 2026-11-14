# Current Wallie visual references

These captures show the current Wallie components with deterministic preview data.
They are the starting point for comparison when implementing the [factory roadmap](../../plans/factory-implementation-plan.md).
The roadmap links to a separate prototype of the future product.

Captured with Chromium 149.0.7827.55 on macOS from a Next.js production build in preview mode.
Desktop is 1440 × 900 and compact is 390 × 844. The images preserve each capture’s pixels using lossless WebP.

To reproduce, run [the factory reference suite](../../development/verification.md#current-design-reference).
It writes the original PNGs under the Playwright output directory.

| Surface          | State                       | Desktop light                                      | Desktop dark                                      | Compact light                                      | Compact dark                                      |
| ---------------- | --------------------------- | -------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| Pipeline         | Populated                   | [View](pipeline-desktop-light.webp)                | [View](pipeline-desktop-dark.webp)                | [View](pipeline-compact-light.webp)                | [View](pipeline-compact-dark.webp)                |
| Pipeline         | Loading                     | [View](pipeline-loading-desktop-light.webp)        | [View](pipeline-loading-desktop-dark.webp)        | [View](pipeline-loading-compact-light.webp)        | [View](pipeline-loading-compact-dark.webp)        |
| Pipeline         | Empty                       | [View](pipeline-empty-desktop-light.webp)          | [View](pipeline-empty-desktop-dark.webp)          | [View](pipeline-empty-compact-light.webp)          | [View](pipeline-empty-compact-dark.webp)          |
| Pipeline         | Partial lane                | [View](pipeline-partial-desktop-light.webp)        | [View](pipeline-partial-desktop-dark.webp)        | [View](pipeline-partial-compact-light.webp)        | [View](pipeline-partial-compact-dark.webp)        |
| Pipeline         | Pagination error            | [View](pipeline-page-error-desktop-light.webp)     | [View](pipeline-page-error-desktop-dark.webp)     | [View](pipeline-page-error-compact-light.webp)     | [View](pipeline-page-error-compact-dark.webp)     |
| Sessions         | Populated                   | [View](sessions-desktop-light.webp)                | [View](sessions-desktop-dark.webp)                | [View](sessions-compact-light.webp)                | [View](sessions-compact-dark.webp)                |
| Sessions         | Empty                       | [View](sessions-empty-desktop-light.webp)          | [View](sessions-empty-desktop-dark.webp)          | [View](sessions-empty-compact-light.webp)          | [View](sessions-empty-compact-dark.webp)          |
| Sessions         | Loading                     | [View](sessions-loading-desktop-light.webp)        | [View](sessions-loading-desktop-dark.webp)        | [View](sessions-loading-compact-light.webp)        | [View](sessions-loading-compact-dark.webp)        |
| Review Workbench | Artifact and review actions | [View](review-workbench-desktop-light.webp)        | [View](review-workbench-desktop-dark.webp)        | [View](review-workbench-compact-light.webp)        | [View](review-workbench-compact-dark.webp)        |
| Settings         | Integrations                | [View](settings-desktop-light.webp)                | [View](settings-desktop-dark.webp)                | [View](settings-compact-light.webp)                | [View](settings-compact-dark.webp)                |
| Settings         | Partial usage               | [View](settings-partial-usage-desktop-light.webp)  | [View](settings-partial-usage-desktop-dark.webp)  | [View](settings-partial-usage-compact-light.webp)  | [View](settings-partial-usage-compact-dark.webp)  |
| Settings         | Setup error                 | [View](settings-error-desktop-light.webp)          | [View](settings-error-desktop-dark.webp)          | [View](settings-error-compact-light.webp)          | [View](settings-error-compact-dark.webp)          |
| Onboarding       | Setup                       | [View](onboarding-desktop-light.webp)              | [View](onboarding-desktop-dark.webp)              | [View](onboarding-compact-light.webp)              | [View](onboarding-compact-dark.webp)              |
| Onboarding       | Blocked verification        | [View](onboarding-blocked-desktop-light.webp)      | [View](onboarding-blocked-desktop-dark.webp)      | [View](onboarding-blocked-compact-light.webp)      | [View](onboarding-blocked-compact-dark.webp)      |
| Route recovery   | Page error                  | [View](route-recoverable-error-desktop-light.webp) | [View](route-recoverable-error-desktop-dark.webp) | [View](route-recoverable-error-compact-light.webp) | [View](route-recoverable-error-compact-dark.webp) |
