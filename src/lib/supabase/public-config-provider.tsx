"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { SupabasePublicConfig } from "@/lib/supabase/config";

const SupabasePublicConfigContext = createContext<SupabasePublicConfig | null>(null);

export function SupabasePublicConfigProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: SupabasePublicConfig | null;
}) {
  return (
    <SupabasePublicConfigContext.Provider value={value}>
      {children}
    </SupabasePublicConfigContext.Provider>
  );
}

export function useSupabasePublicConfig() {
  return useContext(SupabasePublicConfigContext);
}
