import { useState, type ReactNode } from "react";
import { Header } from "./Header.js";
import { NotesDrawer } from "./NotesDrawer.js";
import {
  LayoutDashboard,
  Brain,
  History,
  Activity,
  Settings,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

type Tab = "dashboard" | "strategies" | "trades" | "observability" | "settings";

const navItems: Array<{ id: Tab; label: string; icon: typeof LayoutDashboard }> = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "strategies", label: "Strategies", icon: Brain },
  { id: "trades", label: "Trades", icon: History },
  { id: "observability", label: "Observability", icon: Activity },
  { id: "settings", label: "Settings", icon: Settings },
];

interface LayoutProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  children: ReactNode;
}

export function Layout({ activeTab, onTabChange, children }: LayoutProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden">
      <aside
        className={`flex flex-col border-r border-[var(--border)] bg-[var(--bg-secondary)] transition-all duration-200 ${
          collapsed ? "w-16" : "w-52"
        }`}
      >
        <div className="flex items-center justify-end p-2">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="p-1.5 rounded hover:bg-[var(--bg-card)] text-[var(--text-secondary)]"
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>

        <nav className="flex flex-col gap-1 px-2 flex-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  active
                    ? "bg-[var(--accent-blue)]/15 text-[var(--accent-blue)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
                }`}
              >
                <Icon size={18} />
                {!collapsed && <span>{item.label}</span>}
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="flex flex-col flex-1 overflow-hidden">
        <Header />
        <main className="flex-1 overflow-auto p-4">{children}</main>
        <NotesDrawer />
      </div>
    </div>
  );
}

export type { Tab };
