import {
  AgentProviderLogo,
  AGENT_PROVIDER_LABELS,
} from "@/components/shared/agent-provider-options";
import { WallieMark } from "@/components/shared/wallie-mark";

import { AnimatedFigure } from "./animated-figure";
import { AnimatedProviderRow } from "./animated-provider-row";
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
      <AnimatedFigure caption="Choose your coding agent">
        <AnimatedProviderRow
          className={styles.agents}
          label="Supported coding agents"
          intervalMs={1500}
          choices={agents.map((provider) => ({
            id: provider,
            label: AGENT_PROVIDER_LABELS[provider],
            logo: <AgentProviderLogo provider={provider} className="size-6" />,
          }))}
        />
        <p className={`${styles.figureTitle} ${styles.sandboxTitle}`}>Choose your sandbox</p>
        <AnimatedProviderRow
          className={styles.sandboxes}
          label="Supported sandbox providers"
          intervalMs={2000}
          choices={sandboxes.map(({ id, label }) => ({
            id,
            label,
            logo: <SandboxProviderLogo brand={id} />,
          }))}
        />
      </AnimatedFigure>

      <AnimatedFigure caption="Design your workflow" className={styles.workflow}>
        <div className={styles.workflowCanvas} aria-hidden="true">
          <ol className={styles.stages}>
            <li className={`${styles.stage} ${styles.planStage}`}>
              <span className={styles.stageNode}>
                <WallieMark className="size-5" />
              </span>
              <span className={styles.stageName}>Plan</span>
              <span className={styles.stageOwner}>Wallie</span>
            </li>
            <li className={`${styles.stage} ${styles.reviewStage}`}>
              <span className={styles.stageNode}>
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.5" />
                  <path
                    d="M5 21v-2a7 7 0 0 1 14 0v2"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              <span className={styles.stageName}>Review</span>
              <span className={styles.stageOwner}>You</span>
            </li>
            <li className={`${styles.stage} ${styles.buildStage}`}>
              <span className={styles.stageNode}>
                <WallieMark className="size-5" />
              </span>
              <span className={styles.stageName}>Build</span>
              <span className={styles.stageOwner}>Wallie</span>
            </li>
          </ol>
          <div className={styles.addStage}>
            <span className={styles.addNode}>+</span>
            <span className={styles.stageName}>Add stage</span>
          </div>
          <div className={styles.workflowCursor}>
            <svg width="22" height="26" viewBox="0 0 22 26" fill="none">
              <path
                d="m3 2 15 13-7 1 4 7-3 2-4-8-5 5V2Z"
                fill="var(--foreground)"
                stroke="var(--canvas)"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>
        <div className={styles.workflowStatus} aria-hidden="true">
          <span className={styles.startStatus}>Start with your first stage</span>
          <span className={styles.planStatus}>You add a planning stage</span>
          <span className={styles.reviewStatus}>You add a human review</span>
          <span className={styles.buildStatus}>You add a build stage</span>
          <span className={styles.workingStatus}>Wallie is working on the plan</span>
          <span className={styles.waitingStatus}>Waiting for your review</span>
          <span className={styles.workflowSummary}>Wallie works. You review.</span>
        </div>
        <p className="sr-only">
          Build your own workflow by adding as many stages as you need. In this example, you add
          Plan, a human Review, and Build. Wallie agents work on the square nodes; human review
          steps use round nodes and wait for your approval.
        </p>
      </AnimatedFigure>
    </div>
  );
}
