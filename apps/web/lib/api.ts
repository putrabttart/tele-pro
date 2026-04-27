const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

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

  let response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers
  });

  // Auto-refresh on 401
  if (response.status === 401) {
    const refreshToken = getRefreshToken();
    if (refreshToken) {
      try {
        const refreshRes = await fetch(`${API_URL}/api/auth/refresh`, {
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
          response = await fetch(`${API_URL}${path}`, { ...init, headers });
        } else {
          clearToken();
          throw new Error("Session expired. Silakan login ulang.");
        }
      } catch {
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

export const apiBaseUrl = API_URL;
