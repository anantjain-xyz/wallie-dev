import { Fragment } from "react";

type BrandName = "claude" | "codex" | "cursor" | "daytona" | "e2b" | "linear" | "vercel";

function BrandGlyph({ brand }: { brand: BrandName }) {
  if (brand === "vercel") {
    // Vercel mark (Simple Icons)
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
        <path d="m12 1.608 12 20.784H0Z" />
      </svg>
    );
  }

  if (brand === "linear") {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" strokeWidth="2" />
        <path d="m5.6 8.2 10.2 10.2M4.2 12l7.8 7.8M8.2 5.6l10.2 10.2" strokeWidth="1.5" />
      </svg>
    );
  }

  if (brand === "cursor") {
    // Cursor mark (Simple Icons)
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
        <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
      </svg>
    );
  }

  if (brand === "claude") {
    // Claude spark mark (Simple Icons)
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
        <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
      </svg>
    );
  }

  if (brand === "codex") {
    // OpenAI mark (Simple Icons)
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
        <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654 2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
      </svg>
    );
  }

  if (brand === "e2b") {
    // E2B wordmark (e2b.dev)
    return (
      <svg viewBox="0 0 65 18" className="h-1.5 w-auto fill-current" aria-hidden="true">
        <path d="M20.2235 0V4.67645H5.49328C5.04263 4.67661 4.67645 5.0426 4.67645 5.49328V5.84494C4.67645 6.29563 5.04263 6.66161 5.49328 6.66178H20.2235V11.3382H5.49328C5.04263 11.3384 4.67645 11.7044 4.67645 12.1551V12.5067C4.67657 12.9573 5.04271 13.3222 5.49328 13.3223H20.2235V18H3.12668C1.39998 17.9996 1.98414e-05 16.5989 0 14.8721V3.12668C0.000280465 1.40008 1.40013 0.000432767 3.12668 0H20.2235Z" />
        <path d="M39.2723 0C40.9992 0.000155056 42.399 1.40092 42.399 3.12791V8.36701C42.3989 10.0101 41.0672 11.3417 39.424 11.3419H36.9587C36.9413 11.3408 36.9232 11.3382 36.9057 11.3382H27.6379C27.1873 11.3384 26.8211 11.7044 26.8211 12.1551V12.5067C26.8213 12.9572 27.1874 13.3221 27.6379 13.3223H42.3903V18H22.1446V9.63299C22.1446 7.98998 23.4767 6.65732 25.1195 6.65684H27.5762C27.5967 6.65838 27.6174 6.66174 27.6379 6.66178H36.9057C37.3563 6.66171 37.7225 6.29578 37.7225 5.84494V5.49328C37.7224 5.04255 37.3563 4.67775 36.9057 4.67768H22.1755V0H39.2723Z" />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M61.4379 0C63.1648 3.6786e-05 64.5655 1.39985 64.5658 3.12668V14.8721C64.5658 16.5992 63.1649 18 61.4379 18H44.3386V0H61.4379ZM49.8319 11.3382C49.3813 11.3384 49.0151 11.7044 49.0151 12.1551V12.5067C49.0152 12.9573 49.3813 13.3222 49.8319 13.3223H59.0725C59.523 13.3222 59.888 12.9574 59.8881 12.5067V12.1551C59.8881 11.7043 59.5231 11.3384 59.0725 11.3382H49.8319ZM49.8319 4.67645C49.3813 4.67661 49.0151 5.0426 49.0151 5.49328V5.84494C49.0151 6.29562 49.3813 6.66161 49.8319 6.66178H59.0725C59.5231 6.66162 59.8881 6.29571 59.8881 5.84494V5.49328C59.8881 5.04252 59.5231 4.67661 59.0725 4.67645H49.8319Z"
        />
      </svg>
    );
  }

  // Daytona mark (daytona.io)
  return (
    <svg viewBox="0 0 275 287" className="h-4 w-4 fill-current" aria-hidden="true">
      <path d="M14.5584 193.736H114.275V227.925H14.5584V193.736Z" />
      <path d="M148.464 74.076H262.426V108.265H148.464V74.076Z" />
      <path d="M88.6338 84.6127L173.246 0L197.422 24.175L112.809 108.788L88.6338 84.6127Z" />
      <path d="M89.157 170.084L24.175 105.102L0 129.277L64.9819 194.259L89.157 170.084Z" />
      <path d="M174.629 217.911L106.133 286.407L81.9577 262.232L150.454 193.736L174.629 217.911Z" />
      <path d="M174.106 132.44L250.66 208.994L274.835 184.819L198.281 108.265L174.106 132.44Z" />
      <path d="M88.6338 48.434V131.057H54.4451L54.4451 48.434H88.6338Z" />
      <path d="M208.294 168.094V270.66H174.106V168.094H208.294Z" />
    </svg>
  );
}

function BrandMark({ brand, label }: { brand: BrandName; label: string }) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-2 rounded-[6px] border border-border/50 bg-canvas px-2.5 py-2.5 min-[480px]:flex-row min-[480px]:items-center">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] bg-sheet text-foreground shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--border)_50%,transparent)]">
        <BrandGlyph brand={brand} />
      </span>
      <span className="min-w-0 text-xs font-semibold leading-4 text-foreground">{label}</span>
    </div>
  );
}

export function StackWorkflowMockup() {
  return (
    <figure className="overflow-hidden rounded-[10px] border border-border/50 bg-sheet shadow-[var(--shadow-elevated)]">
      <figcaption className="border-b border-border/50 bg-control-hover px-4 py-3 font-mono text-xs font-medium uppercase tracking-[0.12em] text-muted">
        Set up Wallie
      </figcaption>
      <div aria-hidden="true" className="p-4 sm:p-5">
        <div>
          <p className="font-mono type-annotation font-semibold uppercase tracking-[0.12em] text-muted">
            Coding agents
          </p>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <BrandMark brand="codex" label="Codex" />
            <BrandMark brand="claude" label="Claude Code" />
            <BrandMark brand="cursor" label="Cursor" />
          </div>
        </div>

        <div className="mt-4">
          <p className="font-mono type-annotation font-semibold uppercase tracking-[0.12em] text-muted">
            Sandboxes
          </p>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <BrandMark brand="vercel" label="Vercel" />
            <BrandMark brand="e2b" label="E2B" />
            <BrandMark brand="daytona" label="Daytona" />
          </div>
        </div>

        <div className="mt-4">
          <p className="font-mono type-annotation font-semibold uppercase tracking-[0.12em] text-muted">
            Pipeline
          </p>
          <div className="mt-2 rounded-[6px] border border-border/50 bg-canvas p-3">
            <div className="flex items-center gap-1">
              {["Plan", "Design", "Build", "Land"].map((stage, index) => (
                <Fragment key={stage}>
                  {index > 0 ? (
                    <span className="shrink-0 type-annotation text-muted">→</span>
                  ) : null}
                  <div className="min-w-0 flex-1 rounded-[5px] border border-border/50 bg-sheet px-1.5 py-2 text-center type-annotation font-semibold text-foreground">
                    {stage}
                  </div>
                </Fragment>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-1.5 type-annotation text-muted">
          <span className="flex h-5 w-5 items-center justify-center">
            <BrandGlyph brand="linear" />
          </span>
          Issues synced from Linear
        </div>
      </div>
    </figure>
  );
}
