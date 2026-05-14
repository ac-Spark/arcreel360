import { useEffect, useMemo, useState } from "react";
import { API } from "@/api";
import { getCustomProviderModels, getProviderModels, lookupSupportedDurations } from "@/utils/provider-models";
import type { CustomProviderInfo, ProviderInfo } from "@/types";

export function useVideoDurationOptions(projectVideoBackend: string | null | undefined) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [customProviders, setCustomProviders] = useState<CustomProviderInfo[]>([]);
  const [globalVideoBackend, setGlobalVideoBackend] = useState("");

  useEffect(() => {
    let disposed = false;

    Promise.all([getProviderModels(), getCustomProviderModels(), API.getSystemConfig()])
      .then(([providerList, customProviderList, config]) => {
        if (disposed) return;
        setProviders(providerList);
        setCustomProviders(customProviderList);
        setGlobalVideoBackend(config.settings?.default_video_backend ?? "");
      })
      .catch(() => {});

    return () => {
      disposed = true;
    };
  }, []);

  return useMemo(() => {
    const backend = projectVideoBackend || globalVideoBackend;
    if (!backend) return undefined;
    return lookupSupportedDurations(providers, backend, customProviders);
  }, [customProviders, globalVideoBackend, projectVideoBackend, providers]);
}
