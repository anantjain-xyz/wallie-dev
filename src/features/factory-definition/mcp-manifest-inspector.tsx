import { MetadataItem, MetadataList, PageSection } from "@/components/ui/page-shell";
import type { FactoryMcpManifest } from "@/lib/factory-mcp/manifest";

export function FactoryMcpManifestInspector({
  manifest,
  tagline,
}: {
  manifest?: FactoryMcpManifest;
  tagline?: string;
}) {
  return (
    <PageSection anchorId="mcp-tool-manifest" tagline={tagline} title="MCP tool manifest">
      <div className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5">
        {manifest ? (
          <>
            <MetadataList>
              <MetadataItem label="Agent ID" monospace value={manifest.agentId} />
            </MetadataList>
            <ul className="space-y-4" aria-label="Approved MCP servers">
              {manifest.servers.map((server) => (
                <li className="space-y-3 border-t border-border pt-4" key={server.toolRevisionId}>
                  <h3 className="type-section-title break-words text-foreground">
                    {server.serverSlug} · Revision {server.revisionNumber}
                  </h3>
                  <MetadataList>
                    <MetadataItem label="Revision ID" monospace value={server.toolRevisionId} />
                    <MetadataItem
                      label="Endpoint"
                      value={<span className="break-all">{server.endpoint}</span>}
                    />
                    <MetadataItem
                      label="Approved operations"
                      value={
                        <ul className="space-y-1 break-all font-mono">
                          {server.operations.map((operation) => (
                            <li key={operation}>{operation}</li>
                          ))}
                        </ul>
                      }
                    />
                    {server.auth.kind === "bearer" && (
                      <MetadataItem
                        label="Secret binding ID"
                        monospace
                        value={server.auth.secretBindingId}
                      />
                    )}
                  </MetadataList>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="type-secondary text-muted">
            Empty MCP manifest. Add bindings in JSON source.
          </p>
        )}
      </div>
    </PageSection>
  );
}
