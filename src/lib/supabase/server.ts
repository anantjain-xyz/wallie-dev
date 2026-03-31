import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "@/lib/supabase/database.types";
import { resolveSupabasePublicConfig } from "@/lib/supabase/config";
import type { SupabaseCookieValue } from "@/lib/supabase/types";

type CookieStore = Awaited<ReturnType<typeof cookies>> | {
  getAll: () => { name: string; value: string }[];
  set: (name: string, value: string, options?: object) => void;
};

type CookieAdapterValue = {
  name: string;
  options?: object;
  value: string;
};

export function toSupabaseCookieValues(
  cookiesToSet: CookieAdapterValue[],
): SupabaseCookieValue[] {
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
        const fallbackValues = toSupabaseCookieValues(cookiesToSet);

        cookiesToSet.forEach(({ name, options, value }, index) => {
          try {
            resolvedCookieStore.set(name, value, options);
          } catch {
            const fallbackValue = fallbackValues[index];

            resolvedCookieStore.set(fallbackValue.name, fallbackValue.value);
          }
        });
      },
    },
  });
}

export const createServerSupabaseClient = createSupabaseServerClient;
