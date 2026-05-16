import { redirect } from "next/navigation";

import { workspaceBasePath } from "@/lib/routes";

type PipelineLegacyPageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
};

export default async function PipelineLegacyPage({ params }: PipelineLegacyPageProps) {
  const { workspaceSlug } = await params;
  redirect(workspaceBasePath(workspaceSlug));
}
