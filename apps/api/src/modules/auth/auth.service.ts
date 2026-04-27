import { createClient } from "@supabase/supabase-js";
import { env } from "../../config/env";
import { ApiError } from "../../utils/api-error";

class AuthService {
  async login(email: string, password: string) {
    // Use anon-level client for login (not service role)
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error || !data.session) {
      throw new ApiError(401, error?.message ?? "Login gagal. Periksa email dan password.");
    }

    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in,
      user: {
        id: data.user.id,
        email: data.user.email
      }
    };
  }

  async refreshSession(refreshToken: string) {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: refreshToken
    });

    if (error || !data.session) {
      throw new ApiError(401, "Session expired. Silakan login ulang.");
    }

    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in
    };
  }
}

export const authService = new AuthService();
