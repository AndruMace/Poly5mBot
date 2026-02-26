// Memory monitoring utility for development
export class MemoryMonitor {
  private static instance: MemoryMonitor;
  private intervalId: number | null = null;
  private isMonitoring = false;

  private constructor() {}

  static getInstance(): MemoryMonitor {
    if (!MemoryMonitor.instance) {
      MemoryMonitor.instance = new MemoryMonitor();
    }
    return MemoryMonitor.instance;
  }

  startMonitoring(intervalMs: number = 30000) {
    if (this.isMonitoring || !this.hasMemorySupport()) return;

    this.isMonitoring = true;
    console.log('🧠 Memory monitoring started');

    this.intervalId = window.setInterval(() => {
      const mem = (performance as any).memory;
      const usedMB = Math.round(mem.usedJSHeapSize / 1048576);
      const totalMB = Math.round(mem.totalJSHeapSize / 1048576);
      const limitMB = Math.round(mem.jsHeapSizeLimit / 1048576);

      console.log(`📊 Memory: ${usedMB}MB used / ${totalMB}MB total / ${limitMB}MB limit`);

      // Warning if memory usage is high
      if (usedMB > 500) {
        console.warn('⚠️ High memory usage detected!');
      }
    }, intervalMs);
  }

  stopMonitoring() {
    if (this.intervalId) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isMonitoring = false;
    console.log('🧠 Memory monitoring stopped');
  }

  // Check if memory API is available (Chrome only)
  private hasMemorySupport(): boolean {
    return typeof (performance as any).memory !== 'undefined';
  }

  // Force garbage collection if available
  forceGC() {
    if ((window as any).gc) {
      (window as any).gc();
      console.log('🗑️ Forced garbage collection');
    }
  }
}

// Export for easy access in dev console
declare global {
  interface Window {
    memoryMonitor: MemoryMonitor;
    gc?: () => void;
  }
}

// Auto-expose in development
if (import.meta.env.DEV) {
  window.memoryMonitor = MemoryMonitor.getInstance();
}
