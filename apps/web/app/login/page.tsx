"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, setToken, setRefreshToken } from "../../lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const result = await apiFetch<{
        access_token: string;
        refresh_token: string;
        user: { id: string; email: string };
      }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      });

      setToken(result.access_token);
      setRefreshToken(result.refresh_token);
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login gagal");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="tbm-login-page">
      {/* Left Side - Login Form */}
      <section className="tbm-login-form-side">
        <div className="tbm-login-topbar">
          <a
            href="#"
            onClick={(event) => event.preventDefault()}
            className="tbm-login-topbar-label"
          >
            Telegram Broadcast Manager
          </a>
          <span className="tbm-login-topbar-badge">BLAST-TELE</span>
        </div>

        <div className="tbm-login-form-wrap">
          <p className="tbm-login-eyebrow">Admin access</p>
          <h1 className="tbm-login-title">Sign In</h1>
          <p className="tbm-login-desc">
            Masuk ke panel admin untuk mengelola session Telegram, grup target, dan campaign broadcast.
          </p>

          <div className="tbm-login-card">
            <form onSubmit={onSubmit}>
              <div className="tbm-field-group">
                <label htmlFor="email" className="tbm-field-label">
                  Email<span className="tbm-required">*</span>
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="admin@example.com"
                  className="tbm-field-input"
                  required
                />
              </div>

              <div className="tbm-field-group">
                <label htmlFor="password" className="tbm-field-label">
                  Password<span className="tbm-required">*</span>
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Masukkan password"
                  className="tbm-field-input"
                  required
                />
              </div>

              {error ? (
                <div className="tbm-login-error">{error}</div>
              ) : null}

              <button
                type="submit"
                disabled={loading}
                className="tbm-login-btn"
              >
                {loading ? (
                  <>
                    <span className="tbm-spinner" />
                    Memverifikasi...
                  </>
                ) : (
                  "Masuk ke Dashboard"
                )}
              </button>
            </form>
          </div>
        </div>
      </section>

      {/* Right Side - Hero */}
      <aside className="tbm-login-hero-side">
        <div className="tbm-login-hero-content">
          <div className="tbm-login-hero-logo">
            <div className="tbm-login-hero-logo-icon">
              <i className="bi bi-broadcast"></i>
            </div>
            <span className="tbm-login-hero-logo-text">BLAST TELE</span>
          </div>

          <p className="tbm-login-hero-eyebrow">Broadcast Operations Panel</p>
          <h2 className="tbm-login-hero-title">
            A cleaner entry point for Telegram broadcast operations.
          </h2>
          <p className="tbm-login-hero-desc">
            Kelola session Telegram, target group, scheduling, dan status pengiriman dari satu panel yang lebih fokus dan mudah dibaca.
          </p>
        </div>

        <div className="tbm-login-hero-features">
          <div className="tbm-login-hero-feature">
            <p className="tbm-login-hero-feature-label">Session</p>
            <p className="tbm-login-hero-feature-value">OTP Flow</p>
            <p className="tbm-login-hero-feature-desc">Satu alur login untuk aktivasi akun Telegram.</p>
          </div>
          <div className="tbm-login-hero-feature">
            <p className="tbm-login-hero-feature-label">Broadcast</p>
            <p className="tbm-login-hero-feature-value">Scheduler</p>
            <p className="tbm-login-hero-feature-desc">Atur pengiriman langsung atau terjadwal.</p>
          </div>
        </div>
      </aside>
    </main>
  );
}
