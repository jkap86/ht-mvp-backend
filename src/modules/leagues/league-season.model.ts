/**
 * LeagueSeason Model
 * Represents a single competitive year/season of a league
 */

export type SeasonStatus = 'pre_draft' | 'drafting' | 'in_season' | 'playoffs' | 'completed';
export type PhaseStatus = 'pre_season' | 'regular_season' | 'playoffs' | 'offseason';

export interface LeagueSeasonSettings {
  keeper_deadline?: string; // ISO datetime string
  max_keepers?: number;
  keeper_costs_enabled?: boolean;
  [key: string]: any; // Allow other season-specific overrides
}

export class LeagueSeason {
  constructor(
    public readonly id: number,
    public readonly leagueId: number,
    public readonly season: number,
    public readonly status: SeasonStatus,
    public readonly seasonStatus: PhaseStatus,
    public readonly currentWeek: number,
    public readonly seasonSettings: LeagueSeasonSettings,
    public readonly startedAt: Date | null,
    public readonly completedAt: Date | null,
    public readonly createdAt: Date,
    public readonly updatedAt: Date
  ) {}

  static fromDatabase(row: any): LeagueSeason {
    return new LeagueSeason(
      row.id,
      row.league_id,
      row.season,
      row.status,
      row.season_status,
      row.current_week || 1,
      row.season_settings || {},
      row.started_at ? new Date(row.started_at) : null,
      row.completed_at ? new Date(row.completed_at) : null,
      new Date(row.created_at),
      new Date(row.updated_at)
    );
  }

  toDatabase(): any {
    return {
      id: this.id,
      league_id: this.leagueId,
      season: this.season,
      status: this.status,
      season_status: this.seasonStatus,
      current_week: this.currentWeek,
      season_settings: JSON.stringify(this.seasonSettings),
      started_at: this.startedAt,
      completed_at: this.completedAt,
      created_at: this.createdAt,
      updated_at: this.updatedAt,
    };
  }

  /**
   * Check if this season is currently active (not completed)
   */
  isActive(): boolean {
    return this.status !== 'completed';
  }

  /**
   * Check if keeper selection is enabled for this season
   */
  hasKeeperDeadline(): boolean {
    return !!this.seasonSettings.keeper_deadline;
  }

  /**
   * Check if keeper deadline has passed
   */
  isKeeperDeadlinePassed(): boolean {
    if (!this.seasonSettings.keeper_deadline) {
      return false;
    }
    return new Date() > new Date(this.seasonSettings.keeper_deadline);
  }

  /**
   * Get the maximum number of keepers allowed
   */
  getMaxKeepers(): number {
    return this.seasonSettings.max_keepers || 0;
  }
}

export interface CreateLeagueSeasonParams {
  leagueId: number;
  season: number;
  status?: SeasonStatus;
  seasonStatus?: PhaseStatus;
  currentWeek?: number;
  seasonSettings?: LeagueSeasonSettings;
  startedAt?: Date;
}

export interface UpdateLeagueSeasonParams {
  status?: SeasonStatus;
  seasonStatus?: PhaseStatus;
  currentWeek?: number;
  seasonSettings?: LeagueSeasonSettings;
  startedAt?: Date;
  completedAt?: Date;
}
