"use client";

import "./globals.css";

import Link from "next/link";

export default function GlobalErrorPage({ reset }: { reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <title>Page couldn’t load | Wallie</title>
        <main className="mx-auto max-w-xl px-6 py-16">
          <h1 className="type-page-title">Wallie couldn’t load</h1>
          <p className="mt-3 type-body text-muted">
            Try loading the page again. If it still won’t load, ask your workspace administrator for
            help.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button className="ui-button-primary" type="button" onClick={reset}>
              Try again
            </button>
            <Link className="ui-button" href="/recovery" prefetch={false}>
              Get help
            </Link>
          </div>
        </main>
      </body>
    </html>
  );
}
