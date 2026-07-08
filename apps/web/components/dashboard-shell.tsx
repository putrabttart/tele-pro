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
  onSectionChange,
  onRefresh,
  onLogout
}: DashboardShellProps) {
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
                <i className="bi bi-broadcast"></i>
              </div>
              <div className="tbm-brand-text">
                <strong>BLAST TELE</strong>
                <small>Broadcast Manager</small>
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
              <div className="tbm-sidebar-stats-title">System Snapshot</div>
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
                    placeholder="Search sections..."
                    className="tbm-topbar-search-input"
                    value={topbarSearch}
                    onChange={(event) => setTopbarSearch(event.target.value)}
                  />
                </div>
              </div>

              <div className="tbm-topbar-right">
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
                      <option value={5}>5s</option>
                      <option value={10}>10s</option>
                      <option value={15}>15s</option>
                      <option value={30}>30s</option>
                      <option value={60}>60s</option>
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
              <div className="tbm-hero">
                <p className="tbm-hero-breadcrumb">Dashboard / {selectedSection.label}</p>
                <h1 className="tbm-hero-title">{selectedSection.label}</h1>
                <p className="tbm-hero-subtitle">{selectedSection.subtitle}</p>

                <div className="tbm-hero-pills">
                  <span className="tbm-hero-pill">Runs: {runsCount}</span>
                  <span className="tbm-hero-pill">Schedules: {schedulesCount}</span>
                  <span className="tbm-hero-pill">Templates: {templatesCount}</span>
                  <span className="tbm-hero-pill">Log entries: {sendLogsCount}</span>
                  {lastRefreshedAt ? (
                    <span className="tbm-hero-pill tbm-hero-pill-live">
                      {autoRefresh ? <span className="tbm-live-dot"></span> : null}
                      Terakhir update: {lastRefreshedAt.toLocaleTimeString("id-ID")}
                    </span>
                  ) : null}
                </div>
              </div>

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
