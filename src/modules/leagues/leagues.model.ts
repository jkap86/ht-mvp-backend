/**
 * League domain model
 */
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
    public readonly commissionerRosterId?: number
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
      row.commissioner_roster_id
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
}
