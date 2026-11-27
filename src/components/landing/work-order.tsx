"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import styles from "./landing.module.css";

const stations = [
  {
    name: "Intake",
    art: (
      <>
        <path d="M5 26h60v16H5zM5 31h17l6 5h14l6-5h17" />
        <path d="M22 26V6h32v20M29 12h18m-18 6h14M12 45h46" />
      </>
    ),
  },
  {
    name: "Plan",
    art: (
      <path d="M8 32h54m-48 0v12m42-12v12M14 26h42v6H14zM22 26V7h25v19m-20-14h15m-15 5h11m-6 9v-4h10v4M51 26l8-8 3 2-6 6" />
    ),
  },
  {
    name: "Build",
    art: (
      <path d="M12 44V12h8m38 32V12h-8M9 8h52v7H9zm15 7v11h22V15m-11 11v6m-5 0h10m-18 5h26m-30 7h34M48 8V4h7v4M20 22v17m30-17v17" />
    ),
  },
  {
    name: "Dispatch",
    art: (
      <>
        <path d="m9 15 13-9h39v31l-13 8H9zm0 0h39v30m0-30 13-9M22 6v9m31-4h-7m10-2h-7m-25 15v13m0-6c6 0 10-2 10-7" />
        <circle cx="24" cy="23" r="1.6" />
        <circle cx="24" cy="38" r="1.6" />
        <circle cx="34" cy="23" r="1.6" />
      </>
    ),
  },
] as const;

type Station = (typeof stations)[number]["name"];
type BuildVersion = 1 | 2;
type BuildReview = "initial" | "revised" | "approved";

const buildArtifacts = {
  1: {
    title: "It prints a preview. But when?",
    description:
      "The output check passed. The code still calls the deploy API before it checks the flag.",
    code: ["deploy(request)", "if dryRun: print(plan)"],
    proof: "CLI output check: passed. There was no assertion about deploy API calls.",
  },
  2: {
    title: "A dry run skips the deploy call.",
    description:
      "Build reran with the reviewer’s feedback. It returns the preview before it can call the deploy API.",
    code: ["if dryRun: return print(plan)", "deploy(request)"],
    proof:
      "Fixture check: passed. With a mocked deploy API, the expected call count was 0 and the observed count was 0.",
  },
} as const;

const reviewCopy = {
  initial: {
    status: "Awaiting review",
    note: "Send this feedback to rerun Build. The factory definition stays the same.",
  },
  superseded: {
    status: "Changes requested",
    note: "The first version stays in history. Open v2 to see what changed.",
  },
  revised: {
    status: "Revised artifact",
    note: "Review the new artifact. This session still uses factory revision R07.",
  },
  approved: {
    status: "Build v2 approved",
    note: "You approved Build v2 for this session. This did not merge code or edit the factory.",
  },
};

export function WorkOrder() {
  const [station, setStation] = useState<Station>("Intake");
  const [planApproved, setPlanApproved] = useState(false);
  const [review, setReview] = useState<BuildReview>("initial");
  const [version, setVersion] = useState<BuildVersion>(1);
  const [announcement, setAnnouncement] = useState("");
  const stationButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const headings = useRef<Partial<Record<Station, HTMLHeadingElement | null>>>({});
  const evidence = useRef<HTMLDetailsElement>(null);
  const delivery = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<Station | "delivery" | null>(null);
  const stationIndex = stations.findIndex(({ name }) => name === station);
  const artifact = buildArtifacts[version];
  const reviewText = reviewCopy[review !== "initial" && version === 1 ? "superseded" : review];

  useEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target) {
      (target === "delivery" ? delivery.current : headings.current[target])?.focus();
    }
  }, [station, version, review]);

  function selectStation(
    next: Station,
    { focusHeading = false, message = `Work order 024 at ${next}.` } = {},
  ) {
    if (focusHeading) pendingFocus.current = next;
    setStation(next);
    setAnnouncement(message);
  }

  function handleStationKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    switch (event.key) {
      case "ArrowLeft":
        next = (index + stations.length - 1) % stations.length;
        break;
      case "ArrowRight":
        next = (index + 1) % stations.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = stations.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    selectStation(stations[next].name);
    stationButtons.current[next]?.focus();
  }

  function showBuildVersion(next: BuildVersion) {
    if (evidence.current) evidence.current.open = false;
    setVersion(next);
  }

  return (
    <>
      <div className={styles.stationFloor}>
        <div className={styles.stations} role="group" aria-label="Work order stations">
          {stations.map(({ name, art }, index) => (
            <button
              key={name}
              type="button"
              className={styles.station}
              aria-pressed={station === name}
              aria-controls={`station-${name.toLowerCase()}`}
              ref={(button) => {
                stationButtons.current[index] = button;
              }}
              onClick={() => selectStation(name)}
              onKeyDown={(event) => handleStationKey(event, index)}
            >
              <svg viewBox="0 0 70 49" aria-hidden="true">
                {art}
              </svg>
              <span>
                <small aria-hidden="true">0{index + 1}</small> {name}
              </span>
            </button>
          ))}
        </div>
        <div className={styles.conveyor} aria-hidden="true">
          <svg viewBox="0 0 1120 32" preserveAspectRatio="none">
            <defs>
              <pattern id="tour-rollers" width="16" height="32" patternUnits="userSpaceOnUse">
                <path d="M8 7v18" stroke="var(--art-roller)" />
              </pattern>
            </defs>
            <rect x="0" y="5" width="1120" height="22" fill="var(--mist)" />
            <rect x="0" y="5" width="1120" height="22" fill="url(#tour-rollers)" />
            <path d="M0 5h1120M0 27h1120" stroke="var(--art-ink)" strokeWidth="1.5" />
          </svg>
          <div
            className={styles.carrierRow}
            style={{ transform: `translateX(${stationIndex * 100}%)` }}
          >
            <span className={`${styles.technical} ${styles.carrier}`}>WO–024</span>
          </div>
        </div>
      </div>

      <div className={styles.stationPanel} id="station-intake" hidden={station !== "Intake"}>
        <div className={styles.panelMain}>
          <p className={`${styles.technical} ${styles.artifactId}`}>Intake ticket / Factory R07</p>
          <h4
            tabIndex={-1}
            ref={(heading) => {
              headings.current.Intake = heading;
            }}
          >
            A task becomes a session.
          </h4>
          <p className={styles.taskCopy}>
            Print what the CLI would deploy when someone passes <code>--dry-run</code>.
          </p>
          <p>Wallie records the task and active factory revision for this session.</p>
        </div>
        <div className={styles.panelSide}>
          <p className={styles.technical}>Next station / Plan</p>
          <p>Start with a plan before the agent touches the code.</p>
          <button
            type="button"
            className={`${styles.button} ${styles.primary}`}
            onClick={() => selectStation("Plan", { focusHeading: true })}
          >
            Send to Plan{" "}
            <span className={styles.arrow} aria-hidden="true">
              →
            </span>
          </button>
        </div>
      </div>

      <div className={styles.stationPanel} id="station-plan" hidden={station !== "Plan"}>
        <div className={styles.panelMain}>
          <p className={`${styles.technical} ${styles.artifactId}`}>
            <code>plan.md</code> / v1
          </p>
          <h4
            tabIndex={-1}
            ref={(heading) => {
              headings.current.Plan = heading;
            }}
          >
            A plan for the flag.
          </h4>
          <ol className={styles.artifactList}>
            <li>
              Parse <code>--dry-run</code> in the deploy command.
            </li>
            <li>Print the proposed changes in a readable format.</li>
            <li>Add a test for the CLI output.</li>
          </ol>
        </div>
        <div className={styles.panelSide}>
          <p className={styles.technical}>Session review / Plan</p>
          <p>
            {planApproved
              ? "Plan v1 approved. The approved plan is an input to Build."
              : "When you approve this version, Build receives it as input."}
          </p>
          <button
            type="button"
            className={`${styles.button} ${styles.primary}`}
            onClick={() => {
              setPlanApproved(true);
              selectStation("Build", {
                focusHeading: true,
                message: "Plan v1 approved. The work order is at Build.",
              });
            }}
          >
            Approve plan &amp; continue{" "}
            <span className={styles.arrow} aria-hidden="true">
              →
            </span>
          </button>
        </div>
      </div>

      <div className={styles.stationPanel} id="station-build" hidden={station !== "Build"}>
        <div className={styles.panelMain}>
          <p className={`${styles.technical} ${styles.artifactId}`}>
            <code>build-report.md</code> / v{version}
          </p>
          <h4
            tabIndex={-1}
            ref={(heading) => {
              headings.current.Build = heading;
            }}
          >
            {artifact.title}
          </h4>
          <p>{artifact.description}</p>
          <div className={styles.codeDocket}>
            <div className={styles.technical}>
              <span>Simplified code</span>
              <span>Build v{version}</span>
            </div>
            <pre>
              <code>
                <span className={version === 2 ? styles.newLine : undefined}>
                  {artifact.code[0]}
                </span>
                {"\n"}
                <span>{artifact.code[1]}</span>
              </code>
            </pre>
          </div>
          <details className={styles.evidence} ref={evidence}>
            <summary>Read the check evidence</summary>
            <p>{artifact.proof}</p>
          </details>
        </div>
        <div className={styles.panelSide}>
          <p className={styles.technical}>Session review / {reviewText.status}</p>
          <blockquote className={styles.reviewQuote}>
            Dry runs must never call the deploy API.
          </blockquote>
          <p>{reviewText.note}</p>
          <div className={styles.reviewActions}>
            {review === "initial" && (
              <button
                type="button"
                className={`${styles.button} ${styles.primary}`}
                onClick={() => {
                  pendingFocus.current = "Build";
                  setReview("revised");
                  showBuildVersion(2);
                  setAnnouncement(
                    "The tour reran Build with feedback. Build artifact v2 is ready to review.",
                  );
                }}
              >
                Request changes{" "}
                <span className={styles.arrow} aria-hidden="true">
                  ↻
                </span>
              </button>
            )}
            {version === 2 && review === "revised" && (
              <button
                type="button"
                className={`${styles.button} ${styles.primary}`}
                onClick={() => {
                  pendingFocus.current = "delivery";
                  setReview("approved");
                  setAnnouncement(
                    "Build v2 approved for this session. Delivery is a separate process.",
                  );
                }}
              >
                Approve Build v2{" "}
                <span className={styles.arrow} aria-hidden="true">
                  ✓
                </span>
              </button>
            )}
            {version === 2 && review === "approved" && (
              <button
                type="button"
                className={`${styles.button} ${styles.ghost}`}
                ref={delivery}
                onClick={() => selectStation("Dispatch", { focusHeading: true })}
              >
                See delivery{" "}
                <span className={styles.arrow} aria-hidden="true">
                  →
                </span>
              </button>
            )}
          </div>
          {review !== "initial" && (
            <div
              className={styles.versionControls}
              role="group"
              aria-label="Build artifact versions"
            >
              <span className={styles.technical} aria-hidden="true">
                Compare
              </span>
              {([1, 2] as const).map((candidate) => (
                <button
                  type="button"
                  key={candidate}
                  className={styles.versionButton}
                  aria-pressed={version === candidate}
                  onClick={() => {
                    if (version === candidate) return;
                    showBuildVersion(candidate);
                    setAnnouncement(`Showing Build artifact v${candidate}.`);
                  }}
                >
                  v{candidate}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className={styles.stationPanel} id="station-dispatch" hidden={station !== "Dispatch"}>
        <div className={styles.panelMain}>
          <p className={`${styles.technical} ${styles.artifactId}`}>Dispatch / If configured</p>
          <h4
            tabIndex={-1}
            ref={(heading) => {
              headings.current.Dispatch = heading;
            }}
          >
            Code can leave in a GitHub PR.
          </h4>
          <p>
            With repository access and an eligible delivery policy, Wallie can publish code changes
            to a pull request. Delivery runs separately from stage review; approval doesn’t merge
            it.
          </p>
        </div>
        <div className={styles.panelSide}>
          <p className={styles.technical}>Separate from session review</p>
          <p>Track PR delivery and merge separately. A text-only result doesn’t need a code PR.</p>
          <button
            type="button"
            className={`${styles.button} ${styles.ghost}`}
            onClick={() => {
              setPlanApproved(false);
              setReview("initial");
              showBuildVersion(1);
              selectStation("Intake", { focusHeading: true });
            }}
          >
            Replay the work order{" "}
            <span className={styles.arrow} aria-hidden="true">
              ↺
            </span>
          </button>
        </div>
      </div>
      <p className="sr-only" role="status" aria-atomic="true">
        {announcement}
      </p>
    </>
  );
}
