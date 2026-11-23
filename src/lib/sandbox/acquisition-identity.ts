import type { SandboxAcquisitionIdentity } from "./types";

export function sandboxAcquisitionName(identity: SandboxAcquisitionIdentity) {
  return `wallie-${identity.operationId}`;
}

export function sandboxAcquisitionLabels(identity: SandboxAcquisitionIdentity) {
  return {
    wallie_acquisition_id: identity.operationId,
    wallie_workspace_id: identity.workspaceId,
  };
}
