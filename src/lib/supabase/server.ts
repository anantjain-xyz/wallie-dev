import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "@/lib/supabase/database.types";
import { resolveSupabasePublicConfig } from "@/lib/supabase/config";
import type { SupabaseCookieValue } from "@/lib/supabase/types";

type CookieStore =
  | Awaited<ReturnType<typeof cookies>>
  | {
      getAll: () => { name: string; value: string }[];
      set: (name: string, value: string, options?: object) => void;
    };

type CookieAdapterValue = {
  name: string;
  options?: object;
  value: string;
};

const READ_ONLY_COOKIE_ERROR_MESSAGE =
  "Cookies can only be modified in a Server Action or Route Handler.";

function isReadOnlyCookieError(error: unknown) {
  return error instanceof Error && error.message.includes(READ_ONLY_COOKIE_ERROR_MESSAGE);
}

function setSupabaseCookie(cookieStore: CookieStore, { name, options, value }: CookieAdapterValue) {
  try {
    cookieStore.set(name, value, options);
    return;
  } catch (error) {
    if (isReadOnlyCookieError(error)) {
      return;
    }
  }

  try {
    cookieStore.set(name, value);
  } catch (error) {
    if (isReadOnlyCookieError(error)) {
      return;
    }

    throw error;
  }
}

export function toSupabaseCookieValues(cookiesToSet: CookieAdapterValue[]): SupabaseCookieValue[] {
  return cookiesToSet.map(({ name, value }) => ({
    name,
    value,
  }));
}

export async function createSupabaseServerClient(
  input: Record<string, string | undefined> = process.env,
  cookieStore?: CookieStore,
) {
  const resolvedCookieStore = cookieStore ?? (await cookies());
  const { publishableKey, url } = resolveSupabasePublicConfig(input);

  return createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll() {
        return resolvedCookieStore.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach((cookieToSet) => {
          setSupabaseCookie(resolvedCookieStore, cookieToSet);
        });
      },
    },
  });
}

export const createServerSupabaseClient = createSupabaseServerClient;
