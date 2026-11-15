import { templateVariablePaths } from "@/lib/prompt-templates/render";

const previousStagePrefix = "artifact.previousStages.";

type PromptReferenceError = {
  slug: string;
  code: "missing_reference" | "unreachable_stage";
  message: string;
};

/** Collect each previous-artifact reference once in its first source order. */
export function inspectFactoryPromptReferences(
  template: string,
  stages: readonly { id: string; slug: string }[],
  stageIndex?: number,
): { stageIds: string[]; errors: PromptReferenceError[] } {
  const positions = new Map(stages.map(({ slug }, index) => [slug, index]));
  const slugs = new Set(
    templateVariablePaths(template)
      .filter((path) => path.startsWith(previousStagePrefix))
      .map((path) => path.slice(previousStagePrefix.length)),
  );

  const stageIds: string[] = [];
  const errors: PromptReferenceError[] = [];
  for (const slug of slugs) {
    const position = positions.get(slug);
    if (position === undefined) {
      errors.push({
        slug,
        code: "missing_reference",
        message: `No stage uses the slug "${slug}". Choose an existing stage for this artifact reference.`,
      });
      continue;
    }
    if (stageIndex !== undefined && position >= stageIndex) {
      errors.push({
        slug,
        code: "unreachable_stage",
        message: `The "${slug}" stage must precede this stage for its artifact to be available.`,
      });
      continue;
    }
    stageIds.push(stages[position].id);
  }
  return { stageIds, errors };
}
