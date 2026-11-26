import {
  AgentProviderLogo,
  AGENT_PROVIDER_LABELS,
} from "@/components/shared/agent-provider-options";
import { WallieMark } from "@/components/shared/wallie-mark";

import { SandboxProviderLogo } from "./sandbox-provider-logo";
import styles from "./landing.module.css";

const agents = ["codex", "claude-code", "cursor", "opencode"] as const;
const sandboxes = [
  { id: "vercel", label: "Vercel" },
  { id: "e2b", label: "E2B" },
  { id: "daytona", label: "Daytona" },
] as const;

export function LandingIllustrations() {
  return (
    <div className={styles.illustrations}>
      <figure
        className={styles.workflow}
        aria-labelledby="landing-workflow"
        aria-describedby="landing-workflow-description"
      >
        <figcaption>
          <h2 id="landing-workflow" className="type-section-title">
            Example workflow
          </h2>
        </figcaption>
        <ol className={styles.stages} role="list">
          <li className={styles.stage}>
            <span className={styles.stageNode}>
              <WallieMark className="size-5" />
            </span>
            <span className="font-medium">Plan</span>
            <span className="text-xs text-muted">Wallie</span>
          </li>
          <li className={styles.stage}>
            <span className={`${styles.stageNode} ${styles.approvalNode}`}>
              <svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.5" />
                <path
                  d="M5 21v-2a7 7 0 0 1 14 0v2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <span className="font-medium">Approve plan</span>
            <span className="text-xs text-muted">You</span>
          </li>
          <li className={styles.stage}>
            <span className={styles.stageNode}>
              <WallieMark className="size-5" />
            </span>
            <span className="font-medium">Build</span>
            <span className="text-xs text-muted">Wallie</span>
          </li>
        </ol>
        <p id="landing-workflow-description" className="text-sm leading-5 text-muted">
          Wallie starts the build after you approve the plan.
        </p>
      </figure>

      <div className={styles.providers}>
        <h2 id="landing-agents" className="type-label text-muted">
          Supported coding agents
        </h2>
        <ul className={styles.agents} role="list" aria-labelledby="landing-agents">
          {agents.map((provider) => (
            <li key={provider} className={styles.provider} translate="no">
              <AgentProviderLogo provider={provider} className="size-6" />
              {AGENT_PROVIDER_LABELS[provider]}
            </li>
          ))}
        </ul>
        <h2 id="landing-sandboxes" className="type-label text-muted">
          Supported sandboxes
        </h2>
        <ul className={styles.sandboxes} role="list" aria-labelledby="landing-sandboxes">
          {sandboxes.map(({ id, label }) => (
            <li key={id} className={styles.provider} translate="no">
              <span className="grid size-6 place-items-center">
                <SandboxProviderLogo brand={id} />
              </span>
              {label}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
