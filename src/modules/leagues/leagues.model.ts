/**
 * League domain model
 */

export type LeagueMode = 'redraft' | 'dynasty' | 'keeper';
export type SeasonStatus = 'pre_season' | 'regular_season' | 'playoffs' | 'offseason';

export interface LeagueSettings {
  draftType?: 'snake' | 'linear' | 'third_round_reversal' | 'auction' | 'derby';
  auctionMode?: 'live' | 'slow';
  auctionBudget?: number;
  rosterSlots?: number;
}

export class League {
  constructor(
    public readonly id: number,
    public readonly name: string,
    public readonly status: string,
    public readonly settings: Record<string, any>,
    public readonly scoringSettings: Record<string, any>,
    public readonly season: string,
    public readonly totalRosters: number,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
    public readonly userRosterId?: number,
    public readonly commissionerRosterId?: number,
    public readonly mode: LeagueMode = 'redraft',
    public readonly leagueSettings: LeagueSettings = {},
    public readonly currentWeek: number = 1,
    public readonly seasonStatus: SeasonStatus = 'pre_season',
    public readonly inviteCode?: string,
    public readonly isPublic: boolean = false
  ) {}

  static fromDatabase(row: any): League {
    return new League(
      row.id,
      row.name,
      row.status,
      row.settings || {},
      row.scoring_settings || {},
      row.season,
      row.total_rosters,
      row.created_at,
      row.updated_at,
      row.user_roster_id,
      row.commissioner_roster_id,
      row.mode || 'redraft',
      row.league_settings || {},
      row.current_week || 1,
      row.season_status || 'pre_season',
      row.invite_code,
      row.is_public || false
    );
  }

  toResponse() {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      settings: this.settings,
      scoring_settings: this.scoringSettings,
      season: this.season,
      total_rosters: this.totalRosters,
      created_at: this.createdAt,
      updated_at: this.updatedAt,
      user_roster_id: this.userRosterId,
      commissioner_roster_id: this.commissionerRosterId,
      mode: this.mode,
      league_settings: this.leagueSettings,
      current_week: this.currentWeek,
      season_status: this.seasonStatus,
      invite_code: this.inviteCode,
      is_public: this.isPublic,
    };
  }
}

export interface Roster {
  id: number;
  leagueId: number;
  userId: string | null;
  rosterId: number;
  settings: Record<string, any>;
  starters: string[];
  bench: string[];
  createdAt: Date;
  updatedAt: Date;
  isBenched?: boolean;
  username?: string;
}
