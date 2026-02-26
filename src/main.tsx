import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RegistryProvider } from "@effect-rx/rx-react";
import "./index.css";
import App from "./App.js";

// Initialize memory monitoring in development
if (import.meta.env.DEV) {
  import("./utils/memory-monitor.js").then(() => {
    console.log("💡 Memory monitor available at window.memoryMonitor");
    console.log("   Start monitoring: window.memoryMonitor.startMonitoring()");
    console.log("   Stop monitoring: window.memoryMonitor.stopMonitoring()");
    console.log("   Force GC: window.memoryMonitor.forceGC()");
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RegistryProvider>
      <App />
    </RegistryProvider>
  </StrictMode>,
);
