import {
  AgentProviderLogo,
  AGENT_PROVIDER_LABELS,
} from "@/components/shared/agent-provider-options";
import { CheckIcon } from "@/components/shared/icons/check-icon";

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
        <ol className={styles.stages}>
          <li className={styles.stage}>
            <span className={styles.stageNode} aria-hidden="true">
              <CheckIcon className="size-4" />
            </span>
            <span className={styles.stageName}>Plan</span>
          </li>
          <li className={`${styles.stage} ${styles.reviewStage}`}>
            <span className={styles.stageNode} aria-hidden="true">
              <span className={styles.reviewDot} />
              <span className={styles.reviewCheck}>
                <CheckIcon className="size-4" />
              </span>
            </span>
            <span className={styles.stageName}>Your review</span>
          </li>
          <li className={`${styles.stage} ${styles.buildStage}`}>
            <span className={styles.stageNode} aria-hidden="true">
              <span className={styles.buildIdle}>↗</span>
              <span className={styles.buildSpinner} />
              <span className={styles.buildCheck}>
                <CheckIcon className="size-4" />
              </span>
            </span>
            <span className={styles.stageName}>Build</span>
          </li>
        </ol>
        <div className={styles.workflowStatus} aria-hidden="true">
          <span className={styles.reviewStatus}>Waiting for your review</span>
          <span className={styles.buildStatus}>Your agent is building</span>
          <span className={styles.readyStatus}>Ready for your review</span>
        </div>
        <p className="sr-only">
          Example workflow: plan, wait for your approval, build, then review the result.
        </p>
      </AnimatedFigure>
    </div>
  );
}
