import { IStatsProvider } from './shared/stats-provider.interface';
import { SleeperApiClient } from './sleeper/sleeper-api-client';
import { SleeperStatsProvider } from './sleeper/sleeper-stats-provider';
import { FantasyProsStatsProvider } from './fantasypros/fantasypros-stats-provider';
import { logger } from '../config/logger.config';

export type ProviderType = 'sleeper' | 'fantasypros';

/**
 * Factory for creating stats provider instances
 *
 * This factory encapsulates provider creation logic and allows runtime
 * selection of stats providers based on configuration.
 */
export class StatsProviderFactory {
  /**
   * Create a stats provider based on type
   * @param providerType - Provider identifier (default: 'sleeper')
   * @param config - Optional provider-specific configuration
   * @returns Configured stats provider instance
   */
  static createProvider(
    providerType: ProviderType = 'sleeper',
    config?: Record<string, any>
  ): IStatsProvider {
    logger.info(`Creating stats provider: ${providerType}`);

    switch (providerType) {
      case 'sleeper': {
        const client = new SleeperApiClient();
        return new SleeperStatsProvider(client);
      }

      case 'fantasypros': {
        const apiKey = config?.apiKey || process.env.FANTASYPROS_API_KEY;
        if (!apiKey) {
          throw new Error('FantasyPros API key not configured');
        }
        return new FantasyProsStatsProvider(apiKey);
      }

      default:
        throw new Error(`Unknown stats provider: ${providerType}`);
    }
  }

  /**
   * Get the configured default provider from environment
   * Falls back to 'sleeper' if not specified or invalid
   */
  static getDefaultProviderType(): ProviderType {
    const envProvider = process.env.STATS_PROVIDER as ProviderType;
    return envProvider && ['sleeper', 'fantasypros'].includes(envProvider)
      ? envProvider
      : 'sleeper';
  }
}
