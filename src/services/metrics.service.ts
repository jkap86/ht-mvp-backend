class MetricsService {
  private counters: Map<string, number> = new Map();
  private histograms: Map<string, number[]> = new Map();

  increment(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) || 0) + value);
  }

  recordDuration(name: string, ms: number): void {
    const values = this.histograms.get(name) || [];
    values.push(ms);
    if (values.length > 1000) values.shift(); // Keep last 1000
    this.histograms.set(name, values);
  }

  getMetrics(): Record<string, number> {
    const result: Record<string, number> = {};

    this.counters.forEach((v, k) => {
      result[k] = v;
    });

    this.histograms.forEach((values, name) => {
      if (values.length === 0) return;
      const sorted = [...values].sort((a, b) => a - b);
      result[`${name}_p50`] = sorted[Math.floor(sorted.length * 0.5)] || 0;
      result[`${name}_p95`] = sorted[Math.floor(sorted.length * 0.95)] || 0;
      result[`${name}_p99`] = sorted[Math.floor(sorted.length * 0.99)] || 0;
    });

    return result;
  }
}

export const metrics = new MetricsService();
