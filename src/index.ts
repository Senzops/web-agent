import { SenzorAnalyticsAgent, AnalyticsConfig } from './analytics';
import { SenzorRumAgent, RumConfig } from './rum';

export const Analytics = new SenzorAnalyticsAgent();
export const RUM = new SenzorRumAgent();

// Maintain backwards compatibility
export const Senzor = {
  init: (config: AnalyticsConfig) => Analytics.init(config),
  initRum: (config: RumConfig) => RUM.init(config),
  startSpan: (name: string, meta?: Record<string, any>) => RUM.startSpan(name, meta)
};

// Auto-attach to window for script tag users
if (typeof window !== 'undefined') {
  (window as any).Senzor = Senzor;
}

export type { AnalyticsConfig, RumConfig };