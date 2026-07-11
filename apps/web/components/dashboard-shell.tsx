"use client";

import type { Dispatch, ReactNode, SetStateAction } from "react";

export type DashboardSectionId =
  | "overview"
  | "session"
  | "groups"
  | "templates"
  | "broadcast"
  | "monitoring";

export type DashboardSectionMeta = {
  id: DashboardSectionId;
  label: string;
  subtitle: string;
  icon: string;
};

export type DashboardSectionGroup = {
  label: string;
  items: DashboardSectionId[];
};

type DashboardShellProps = {
  children: ReactNode;
  sections: DashboardSectionMeta[];
  sectionGroups: DashboardSectionGroup[];
  activeSection: DashboardSectionId;
  selectedSection: DashboardSectionMeta;
  sidebarOpen: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  topbarSearch: string;
  setTopbarSearch: Dispatch<SetStateAction<string>>;
  darkMode: boolean;
  setDarkMode: Dispatch<SetStateAction<boolean>>;
  autoRefresh: boolean;
  setAutoRefresh: Dispatch<SetStateAction<boolean>>;
  autoRefreshInterval: number;
  setAutoRefreshInterval: Dispatch<SetStateAction<number>>;
  refreshCountdown: number;
  syncing: boolean;
  notificationCount: number;
  connectedAccountsCount: number;
  activeGroupsCount: number;
  runsCount: number;
  schedulesCount: number;
  templatesCount: number;
  sendLogsCount: number;
  lastRefreshedAt: Date | null;
  error: string;
  notice: string;
  showSnapshot?: boolean;
  onSectionChange: (section: DashboardSectionId) => void;
  onRefresh: () => void | Promise<void>;
  onLogout: () => void;
};

const findSection = (sections: DashboardSectionMeta[], sectionId: DashboardSectionId) => {
  return sections.find((entry) => entry.id === sectionId);
};

export function DashboardShell({
  children,
  sections,
  sectionGroups,
  activeSection,
  selectedSection,
  sidebarOpen,
  setSidebarOpen,
  topbarSearch,
  setTopbarSearch,
  darkMode,
  setDarkMode,
  autoRefresh,
  setAutoRefresh,
  autoRefreshInterval,
  setAutoRefreshInterval,
  refreshCountdown,
  syncing,
  notificationCount,
  connectedAccountsCount,
  activeGroupsCount,
  runsCount,
  schedulesCount,
  templatesCount,
  sendLogsCount,
  lastRefreshedAt,
  error,
  notice,
  showSnapshot = false,
  onSectionChange,
  onRefresh,
  onLogout
}: DashboardShellProps) {
  const systemCards = [
    { label: "Accounts", value: connectedAccountsCount, icon: "bi-phone", tone: "primary" },
    { label: "Groups", value: activeGroupsCount, icon: "bi-collection", tone: "success" },
    { label: "Runs", value: runsCount, icon: "bi-activity", tone: "warning" },
    { label: "Logs", value: sendLogsCount, icon: "bi-journal-text", tone: "info" }
  ];

  return (
    <main className="tbm-admin-page">
      <div className="tbm-layout">
        <div
          className={`tbm-sidebar-overlay ${sidebarOpen ? "tbm-sidebar-overlay-visible" : ""}`}
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        ></div>

        <aside className={`tbm-sidebar ${sidebarOpen ? "tbm-sidebar-open" : ""}`}>
          <div className="tbm-sidebar-header">
            <a href="#" onClick={(event) => event.preventDefault()} className="tbm-brand-link">
              <div className="tbm-brand-icon">
                <i className="bi bi-send-check-fill"></i>
              </div>
              <div className="tbm-brand-text">
                <strong>BLAST TELE</strong>
                <small>Admin Console</small>
              </div>
            </a>
            <button
              type="button"
              className="tbm-sidebar-close"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close navigation"
            >
              <i className="bi bi-x-lg"></i>
            </button>
          </div>

          <div className="tbm-sidebar-profile">
            <div className="tbm-sidebar-profile-avatar">BA</div>
            <div className="tbm-sidebar-profile-copy">
              <span>Broadcast Admin</span>
              <small>{connectedAccountsCount} akun connected</small>
            </div>
          </div>

          <div className="tbm-sidebar-content">
            <nav className="tbm-sidebar-nav" aria-label="Dashboard modules">
              {sectionGroups.length ? (
                sectionGroups.map((group) => (
                  <div key={group.label} className="tbm-nav-group">
                    <h3 className="tbm-nav-group-title">{group.label}</h3>
                    <ul className="tbm-nav-list">
                      {group.items.map((sectionId) => {
                        const item = findSection(sections, sectionId);
                        if (!item) {
                          return null;
                        }

                        const active = activeSection === item.id;

                        return (
                          <li key={item.id}>
                            <button
                              type="button"
                              className={`tbm-nav-item ${active ? "tbm-nav-item-active" : ""}`}
                              onClick={() => onSectionChange(item.id)}
                            >
                              <span className="tbm-nav-icon">
                                <i className={`bi ${item.icon}`}></i>
                              </span>
                              <span className="tbm-nav-label">{item.label}</span>
                              {active ? <span className="tbm-nav-active-mark"></span> : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))
              ) : (
                <div className="tbm-sidebar-empty">Modul tidak ditemukan untuk kata kunci ini.</div>
              )}
            </nav>

            <div className="tbm-sidebar-footer">
              <div className="tbm-sidebar-stats-title">Quick Status</div>
              <div className="tbm-sidebar-stats">
                <span className="tbm-stat-badge">
                  <i className="bi bi-check-circle"></i>
                  Connected: {connectedAccountsCount}
                </span>
                <span className="tbm-stat-badge">
                  <i className="bi bi-collection"></i>
                  Active Groups: {activeGroupsCount}
                </span>
              </div>
              <button type="button" className="tbm-logout-btn" onClick={onLogout}>
                <i className="bi bi-box-arrow-right"></i>
                Logout
              </button>
            </div>
          </div>
        </aside>

        <div className="tbm-main-area">
          <header className="tbm-topbar">
            <div className="tbm-topbar-inner">
              <div className="tbm-topbar-left">
                <button
                  type="button"
                  className="tbm-topbar-toggle"
                  onClick={() => setSidebarOpen((prev) => !prev)}
                  aria-label="Toggle sidebar"
                  aria-expanded={sidebarOpen}
                >
                  <i className="bi bi-list"></i>
                </button>

                <div className="tbm-mobile-page-label">
                  <strong>{selectedSection.label}</strong>
                  <span>{selectedSection.subtitle}</span>
                </div>

                <div className="tbm-topbar-search">
                  <span className="tbm-topbar-search-icon">
                    <i className="bi bi-search"></i>
                  </span>
                  <input
                    type="text"
                    placeholder="Search modules, menus..."
                    className="tbm-topbar-search-input"
                    value={topbarSearch}
                    onChange={(event) => setTopbarSearch(event.target.value)}
                  />
                </div>
              </div>

              <div className="tbm-topbar-right">
                <div className="tbm-topbar-status">
                  <span className="tbm-live-dot"></span>
                  {autoRefresh ? `Auto ${refreshCountdown}s` : "Manual refresh"}
                </div>
                <button
                  type="button"
                  className="tbm-topbar-btn"
                  onClick={() => setDarkMode((prev) => !prev)}
                  aria-label="Toggle dark mode"
                >
                  <i className={`bi ${darkMode ? "bi-sun" : "bi-moon"}`}></i>
                </button>
                <button type="button" className="tbm-topbar-btn" aria-label="Notifications">
                  {notificationCount > 0 ? <span className="tbm-topbar-notification-dot"></span> : null}
                  <i className="bi bi-bell"></i>
                </button>
                <div className="tbm-auto-refresh-controls">
                  <button
                    type="button"
                    className="tbm-topbar-btn"
                    onClick={() => void onRefresh()}
                    disabled={syncing}
                    aria-label="Refresh data"
                  >
                    <i className={`bi ${syncing ? "bi-arrow-repeat tbm-spin" : "bi-arrow-clockwise"}`}></i>
                  </button>
                  <button
                    type="button"
                    className={`tbm-topbar-btn tbm-auto-refresh-toggle ${autoRefresh ? "tbm-auto-refresh-active" : ""}`}
                    onClick={() => setAutoRefresh((prev) => !prev)}
                    aria-label="Toggle auto refresh"
                    title={autoRefresh ? `Auto-refresh ON (${refreshCountdown}s)` : "Auto-refresh OFF"}
                  >
                    {autoRefresh ? <span className="tbm-countdown-badge">{refreshCountdown}</span> : null}
                    <i className={`bi ${autoRefresh ? "bi-broadcast-pin" : "bi-broadcast"}`}></i>
                  </button>
                  {autoRefresh ? (
                    <select
                      className="tbm-refresh-interval-select"
                      value={autoRefreshInterval}
                      onChange={(event) => setAutoRefreshInterval(Number(event.target.value))}
                      title="Interval auto-refresh"
                    >
                      <option value={30}>30s</option>
                      <option value={60}>60s</option>
                      <option value={120}>120s</option>
                    </select>
                  ) : null}
                </div>

                <div className="tbm-topbar-user">
                  <span className="tbm-topbar-user-avatar">AD</span>
                  <span className="tbm-topbar-user-info">
                    <strong>Admin</strong>
                    <small>Broadcast Ops</small>
                  </span>
                </div>
              </div>
            </div>
          </header>

          <main className="tbm-dashboard-main">
            <div className="tbm-page-container">
              <div className="tbm-page-head">
                <div className="tbm-page-title-wrap">
                  <div className="tbm-page-kicker">
                    <span className="tbm-page-kicker-dot"></span>
                    Dashboard / {selectedSection.label}
                  </div>
                  <h1 className="tbm-page-title">{selectedSection.label}</h1>
                  <p className="tbm-page-subtitle">{selectedSection.subtitle}</p>
                </div>

                <div className="tbm-page-head-actions">
                  {lastRefreshedAt ? (
                    <span className="tbm-page-updated">
                      <i className="bi bi-clock-history"></i>
                      {lastRefreshedAt.toLocaleTimeString("id-ID")}
                    </span>
                  ) : null}
                  <button type="button" className="btn btn-primary" onClick={() => void onRefresh()} disabled={syncing}>
                    <i className={`bi ${syncing ? "bi-arrow-repeat tbm-spin" : "bi-arrow-clockwise"} me-2`}></i>
                    Refresh
                  </button>
                </div>
              </div>

              {showSnapshot ? (
                <div className="tbm-admin-snapshot">
                  {systemCards.map((card) => (
                    <div className={`tbm-admin-snapshot-card tbm-admin-snapshot-${card.tone}`} key={card.label}>
                      <span className="tbm-admin-snapshot-icon">
                        <i className={`bi ${card.icon}`}></i>
                      </span>
                      <span className="tbm-admin-snapshot-copy">
                        <strong>{card.value}</strong>
                        <small>{card.label}</small>
                      </span>
                    </div>
                  ))}
                  <div className="tbm-admin-snapshot-card tbm-admin-snapshot-muted">
                    <span className="tbm-admin-snapshot-icon">
                      <i className="bi bi-calendar2-check"></i>
                    </span>
                    <span className="tbm-admin-snapshot-copy">
                      <strong>{schedulesCount}</strong>
                      <small>Schedules</small>
                    </span>
                  </div>
                  <div className="tbm-admin-snapshot-card tbm-admin-snapshot-muted">
                    <span className="tbm-admin-snapshot-icon">
                      <i className="bi bi-file-earmark-text"></i>
                    </span>
                    <span className="tbm-admin-snapshot-copy">
                      <strong>{templatesCount}</strong>
                      <small>Templates</small>
                    </span>
                  </div>
                </div>
              ) : null}

              {error ? <div className="tbm-alert tbm-alert-error">{error}</div> : null}
              {notice ? <div className="tbm-alert tbm-alert-success">{notice}</div> : null}

              <div className="tbm-content-stack">{children}</div>
            </div>
          </main>
        </div>
      </div>

      <nav className="tbm-mobile-nav" aria-label="Mobile dashboard navigation">
        {sections.map((item) => {
          const active = activeSection === item.id;

          return (
            <button
              key={item.id}
              type="button"
              className={`tbm-mobile-nav-item ${active ? "tbm-mobile-nav-item-active" : ""}`}
              onClick={() => onSectionChange(item.id)}
            >
              <i className={`bi ${item.icon}`}></i>
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </main>
  );
}
