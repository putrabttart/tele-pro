const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL ?? "";

const joinApiUrl = (baseUrl: string, path: string) => {
  if (!baseUrl || baseUrl === "/") return path;
  return `${baseUrl.replace(/\/$/, "")}${path}`;
};

class ApiNetworkError extends Error {}

export const getApiBaseUrl = () => {
  if (typeof window === "undefined") {
    return configuredApiUrl;
  }

  const isBrowserLocalhost = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  const configuredIsLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(configuredApiUrl);
  const configuredIsInsecureHttp = /^http:\/\//i.test(configuredApiUrl);

  if (
    !configuredApiUrl
    || (configuredIsLocalhost && !isBrowserLocalhost)
    || (window.location.protocol === "https:" && configuredIsInsecureHttp)
  ) {
    return window.location.origin;
  }

  return configuredApiUrl;
};

const parseApiErrorMessage = async (response: Response) => {
  const raw = await response.text();

  if (!raw) {
    return `Request failed: ${response.status}`;
  }

  try {
    const parsed = JSON.parse(raw) as { message?: string; details?: unknown };
    const base = parsed.message ?? `Request failed: ${response.status}`;

    if (parsed.details === undefined || parsed.details === null) {
      return base;
    }

    const details = typeof parsed.details === "string"
      ? parsed.details
      : JSON.stringify(parsed.details);

    return `${base}: ${details}`;
  } catch {
    return raw.length > 300 ? `${raw.slice(0, 300)}...` : raw;
  }
};

const formatFetchFailureMessage = (path: string, apiUrl: string, error: unknown) => {
  const target = joinApiUrl(apiUrl, path);
  const details = error instanceof Error ? error.message : String(error);
  const isHttpsPage = typeof window !== "undefined" && window.location.protocol === "https:";
  const isHttpApi = /^http:\/\//i.test(target);
  const hint = isHttpsPage && isHttpApi
    ? "Halaman HTTPS tidak bisa memanggil API HTTP. Gunakan URL API HTTPS/tunnel, atau kosongkan NEXT_PUBLIC_API_URL hanya jika rewrite Next sudah mengarah ke API yang benar."
    : "Pastikan API server aktif, URL API benar, dan tunnel/proxy tidak putus saat request berjalan lama.";

  return `Tidak bisa menghubungi API untuk ${path}. ${hint}${details ? ` Detail: ${details}` : ""}`;
};

const fetchApi = async (apiUrl: string, path: string, init?: RequestInit) => {
  try {
    return await fetch(joinApiUrl(apiUrl, path), init);
  } catch (error) {
    throw new ApiNetworkError(formatFetchFailureMessage(path, apiUrl, error));
  }
};

export const getToken = () => {
  if (typeof window === "undefined") {
    return "";
  }

  return localStorage.getItem("tbm_token") ?? "";
};

export const setToken = (token: string) => {
  if (typeof window === "undefined") {
    return;
  }

  localStorage.setItem("tbm_token", token);
};

export const getRefreshToken = () => {
  if (typeof window === "undefined") {
    return "";
  }

  return localStorage.getItem("tbm_refresh_token") ?? "";
};

export const setRefreshToken = (token: string) => {
  if (typeof window === "undefined") {
    return;
  }

  localStorage.setItem("tbm_refresh_token", token);
};

export const clearToken = () => {
  if (typeof window === "undefined") {
    return;
  }

  localStorage.removeItem("tbm_token");
  localStorage.removeItem("tbm_refresh_token");
};

export const apiFetch = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const headers = new Headers(init?.headers ?? {});

  if (!(init?.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const token = getToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const apiUrl = getApiBaseUrl();

  let response = await fetchApi(apiUrl, path, {
    ...init,
    headers
  });

  // Auto-refresh on 401 (skip for auth endpoints — they handle their own 401)
  if (response.status === 401 && !path.startsWith("/api/auth/")) {
    const refreshToken = getRefreshToken();
    if (refreshToken) {
      try {
        const refreshRes = await fetchApi(apiUrl, "/api/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: refreshToken })
        });

        if (refreshRes.ok) {
          const refreshData = await refreshRes.json() as {
            access_token: string;
            refresh_token: string;
          };
          setToken(refreshData.access_token);
          setRefreshToken(refreshData.refresh_token);

          // Retry original request with new token
          headers.set("Authorization", `Bearer ${refreshData.access_token}`);
          response = await fetchApi(apiUrl, path, { ...init, headers });
        } else {
          clearToken();
          throw new Error("Session expired. Silakan login ulang.");
        }
      } catch (error) {
        if (error instanceof ApiNetworkError) {
          throw error;
        }

        clearToken();
        throw new Error("Session expired. Silakan login ulang.");
      }
    } else {
      clearToken();
      throw new Error("Session expired. Silakan login ulang.");
    }
  }

  if (!response.ok) {
    throw new Error(await parseApiErrorMessage(response));
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const raw = await response.text();
  if (!raw) {
    return undefined as T;
  }

  return JSON.parse(raw) as T;
};
