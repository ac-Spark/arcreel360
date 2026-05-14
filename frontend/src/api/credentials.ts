/**
 * Provider 憑證管理 API。
 */

import type { ProviderCredential } from "@/types";
import { API_BASE, throwIfNotOk, withAuth , getApi} from "./_http";
export const credentialsApi = {
  async listCredentials(
    providerId: string,
  ): Promise<{ credentials: ProviderCredential[] }> {
    return getApi().request(`/providers/${encodeURIComponent(providerId)}/credentials`);
  },

  async createCredential(
    providerId: string,
    data: { name: string; api_key?: string; base_url?: string },
  ): Promise<ProviderCredential> {
    return getApi().request(`/providers/${encodeURIComponent(providerId)}/credentials`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  async updateCredential(
    providerId: string,
    credId: number,
    data: { name?: string; api_key?: string; base_url?: string },
  ): Promise<void> {
    return getApi().request(
      `/providers/${encodeURIComponent(providerId)}/credentials/${credId}`,
      { method: "PATCH", body: JSON.stringify(data) },
    );
  },

  async deleteCredential(
    providerId: string,
    credId: number,
  ): Promise<void> {
    return getApi().request(
      `/providers/${encodeURIComponent(providerId)}/credentials/${credId}`,
      { method: "DELETE" },
    );
  },

  async activateCredential(
    providerId: string,
    credId: number,
  ): Promise<void> {
    return getApi().request(
      `/providers/${encodeURIComponent(providerId)}/credentials/${credId}/activate`,
      { method: "POST" },
    );
  },

  async uploadVertexCredential(
    name: string,
    file: File,
  ): Promise<ProviderCredential> {
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch(
      `${API_BASE}/providers/gemini-vertex/credentials/upload?name=${encodeURIComponent(name)}`,
      withAuth({ method: "POST", body: formData }),
    );
    await throwIfNotOk(response, "上傳憑證失敗");
    return response.json();
  },
};
