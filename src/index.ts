import { SenzorAnalyticsAgent, AnalyticsConfig } from './analytics';
import { SenzorRumAgent, RumConfig } from './rum';

export const Analytics = new SenzorAnalyticsAgent();
export const RUM = new SenzorRumAgent();

// Maintain backwards compatibility for existing setup scripts
export const Senzor = {
  init: (config: AnalyticsConfig) => Analytics.init(config),
  initRum: (config: RumConfig) => RUM.init(config)
};

// Auto-attach to window for script tag users
if (typeof window !== 'undefined') {
  (window as any).Senzor = Senzor;
}

export type { AnalyticsConfig, RumConfig };