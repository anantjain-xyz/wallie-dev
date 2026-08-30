import type { SVGProps } from "react";

export function WallieMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      data-wallie-mark=""
      fill="none"
      viewBox="0 0 512 512"
      {...props}
    >
      <path
        fill="currentColor"
        d="M68 170H56c-22.091 0-40 17.909-40 40v92c0 22.091 17.909 40 40 40h12v-172ZM444 170h12c22.091 0 40 17.909 40 40v92c0 22.091-17.909 40-40 40h-12v-172Z"
      />
      <rect width="376" height="336" x="68" y="88" fill="currentColor" rx="108" />
      <rect width="248" height="208" x="132" y="152" fill="var(--surface-sheet)" rx="72" />
      <circle cx="204" cy="244" r="26" fill="currentColor" />
      <circle cx="308" cy="244" r="26" fill="currentColor" />
      <path
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="32"
        d="M204 296c13.333 16 30.667 24 52 24s38.667-8 52-24"
      />
    </svg>
  );
}
